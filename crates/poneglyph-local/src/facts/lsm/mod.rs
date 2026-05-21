#![allow(dead_code)]

mod key;
mod manifest;
mod memtable;
mod merge;
mod sst;
mod wal;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use poneglyph::facts::store::{new_tx_id, sort_facts, validate_pending_fact};
use poneglyph::schema::{SchemaDefinition, SchemaSnapshot};
use poneglyph::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, Store, Uri};
use tokio::sync::mpsc;

use self::manifest::Manifest;
use self::memtable::Memtable;
use self::sst::SstReader;
use self::wal::Wal;

const WAL_FILE: &str = "facts.wal";
const FLUSH_THRESHOLD_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct LsmFactStore {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    dir: PathBuf,
    manifest: Manifest,
    memtable: Memtable,
    wal: Wal,
    segments_newest_first: Vec<SstReader>,
}

impl LsmFactStore {
    pub fn open(path: impl AsRef<Path>) -> PoneResult<Self> {
        let dir = path.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|source| Error::FactStoreIo { source })?;
        let manifest = Manifest::load(&dir).map_err(|source| Error::FactStoreIo { source })?;
        let segments_newest_first = manifest
            .segment_paths(&dir)
            .into_iter()
            .map(SstReader::open)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|source| Error::FactStoreIo { source })?;
        let wal_path = dir.join(WAL_FILE);
        let memtable = wal::replay(&wal_path).map_err(|source| Error::FactStoreIo { source })?;
        let wal = Wal::open(wal_path).map_err(|source| Error::FactStoreIo { source })?;

        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                dir,
                manifest,
                memtable,
                wal,
                segments_newest_first,
            })),
        })
    }

    pub fn flush(&self) -> PoneResult<()> {
        self.inner
            .lock()
            .expect("LSM mutex poisoned")
            .flush_memtable()
    }
}

#[async_trait]
impl Store for LsmFactStore {
    async fn state_facts(
        &self,
        mut fact_stream: mpsc::Receiver<Fact>,
    ) -> PoneResult<(Uri, Vec<Fact>)> {
        let mut facts = Vec::new();
        while let Some(fact) = fact_stream.recv().await {
            facts.push(fact);
        }
        self.state_facts_vec(facts).await
    }

    async fn state_facts_vec(&self, incoming: Vec<Fact>) -> PoneResult<(Uri, Vec<Fact>)> {
        if incoming.is_empty() {
            return Err(Error::EmptyFactBatch);
        }
        for fact in &incoming {
            validate_pending_fact(fact)?;
        }

        self.inner
            .lock()
            .expect("LSM mutex poisoned")
            .state_facts_vec(incoming)
    }

    async fn get_facts(&self, filter: Filter) -> PoneResult<mpsc::Receiver<PoneResult<Fact>>> {
        let rows = self
            .inner
            .lock()
            .expect("LSM mutex poisoned")
            .get_facts(filter)?;
        Ok(send_rows(rows))
    }

    async fn get_active_facts(
        &self,
        filter: ActiveFilter,
    ) -> PoneResult<mpsc::Receiver<PoneResult<ActiveFact>>> {
        let rows = self
            .inner
            .lock()
            .expect("LSM mutex poisoned")
            .get_active_facts(filter)?;
        Ok(send_rows(rows))
    }

    async fn get_schema(&self) -> PoneResult<SchemaDefinition> {
        let facts = self
            .inner
            .lock()
            .expect("LSM mutex poisoned")
            .get_facts(Filter::All)?;
        let mut snapshot = SchemaSnapshot::default();
        for fact in facts {
            snapshot.apply_fact(&fact?);
        }
        Ok(snapshot.into_definition())
    }

    async fn repair(&self) -> PoneResult<()> {
        Ok(())
    }
}

impl Inner {
    fn state_facts_vec(&mut self, incoming: Vec<Fact>) -> PoneResult<(Uri, Vec<Fact>)> {
        let tx_id = new_tx_id();
        let mut active_tuples = self.active_tuple_keys()?;
        let mut persisted = Vec::with_capacity(incoming.len());

        for fact in incoming {
            let tuple_key = active_tuple_key(&fact);
            if fact.retraction {
                if active_tuples.remove(&tuple_key) {
                    persisted.push(fact);
                } else if !self.tuple_ever_stated(&fact)? {
                    return Err(Error::CannotRetractUnknownFact);
                }
            } else {
                active_tuples.insert(tuple_key);
                persisted.push(fact);
            }
        }

        for (seq, fact) in persisted.iter_mut().enumerate() {
            fact.tx_id = Some(tx_id.clone());
            let fact_bytes = serde_json::to_vec(&fact)?;
            self.put(key::log_tx_key(&tx_id, seq as u64), fact_bytes.clone())?;
            self.put(key::log_fact_key(&fact.fact_id), fact_bytes)?;
            self.apply_active_indexes(fact)?;
        }

        self.wal
            .sync()
            .map_err(|source| Error::FactStoreIo { source })?;
        if self.memtable.approximate_size() >= FLUSH_THRESHOLD_BYTES {
            self.flush_memtable()?;
        }
        Ok((tx_id, persisted))
    }

    fn get_facts(&self, filter: Filter) -> PoneResult<Vec<PoneResult<Fact>>> {
        let needs_sort = !matches!(filter, Filter::ById(_));
        let mut facts = match filter {
            Filter::All => self.scan_facts(key::log_all_prefix())?,
            Filter::ById(fact_id) => self
                .get_value(&key::log_fact_key(&fact_id))?
                .map(|bytes| serde_json::from_slice(&bytes).map_err(Error::from))
                .into_iter()
                .collect(),
            Filter::ByTx(tx_id) => self.scan_facts(key::log_tx_prefix(&tx_id))?,
            Filter::ByEntityUri(entity) => self
                .scan_facts(key::log_all_prefix())?
                .into_iter()
                .filter(|fact| match fact {
                    Ok(fact) => fact.entity == entity,
                    Err(_) => true,
                })
                .collect(),
        };
        if needs_sort {
            let mut decoded = facts.into_iter().collect::<PoneResult<Vec<_>>>()?;
            sort_facts(&mut decoded);
            facts = decoded.into_iter().map(Ok).collect();
        }
        Ok(facts)
    }

    fn get_active_facts(&self, filter: ActiveFilter) -> PoneResult<Vec<PoneResult<ActiveFact>>> {
        let prefix = match filter {
            ActiveFilter::All => key::active_all_prefix(),
            ActiveFilter::ByEntity(entity) => key::active_entity_prefix(&entity),
            ActiveFilter::ByField(field) => key::active_field_prefix(&field),
            ActiveFilter::ByFieldEntity { field, entity } => {
                key::active_field_entity_prefix(&field, &entity)
            }
            ActiveFilter::ByFieldValue { field, value } => key::active_value_prefix(&field, &value),
            ActiveFilter::ByFieldEntityValue {
                field,
                entity,
                value,
            } => key::active_field_key(&field, &entity, &value),
        };
        self.scan_values(prefix).map(|rows| {
            rows.into_iter()
                .map(|bytes| serde_json::from_slice(&bytes).map_err(Error::from))
                .collect()
        })
    }

    fn apply_active_indexes(&mut self, fact: &Fact) -> PoneResult<()> {
        let active = ActiveFact {
            source: fact.source.clone(),
            entity: fact.entity.clone(),
            field: fact.field.clone(),
            value: fact.value.clone(),
            fact_id: fact.fact_id.clone(),
            tx_id: fact.tx_id.clone().expect("persisted fact has tx_id"),
        };
        let keys = active_index_keys(&active);
        if fact.retraction {
            for key in keys {
                self.delete(key)?;
            }
        } else {
            let bytes = serde_json::to_vec(&active)?;
            for key in keys {
                self.put(key, bytes.clone())?;
            }
        }
        Ok(())
    }

    fn tuple_ever_stated(&self, candidate: &Fact) -> PoneResult<bool> {
        Ok(self
            .scan_facts(key::log_all_prefix())?
            .into_iter()
            .collect::<PoneResult<Vec<_>>>()?
            .into_iter()
            .any(|fact| same_tuple(&fact, candidate)))
    }

    fn active_tuple_keys(&self) -> PoneResult<BTreeSet<Vec<u8>>> {
        Ok(self
            .scan_values(key::active_all_prefix())?
            .into_iter()
            .map(|bytes| serde_json::from_slice::<ActiveFact>(&bytes).map_err(Error::from))
            .collect::<PoneResult<Vec<_>>>()?
            .into_iter()
            .map(|active| key::active_field_key(&active.field, &active.entity, &active.value))
            .collect())
    }

    fn scan_facts(&self, prefix: Vec<u8>) -> PoneResult<Vec<PoneResult<Fact>>> {
        self.scan_values(prefix).map(|rows| {
            rows.into_iter()
                .map(|bytes| serde_json::from_slice(&bytes).map_err(Error::from))
                .collect()
        })
    }

    fn scan_values(&self, prefix: Vec<u8>) -> PoneResult<Vec<Vec<u8>>> {
        merge::scan_prefix_merged(&self.memtable, &self.segments_newest_first, &prefix)
            .map(|rows| rows.into_iter().map(|(_, value)| value).collect())
            .map_err(|source| Error::FactStoreIo { source })
    }

    fn get_value(&self, key: &[u8]) -> PoneResult<Option<Vec<u8>>> {
        merge::get_merged(&self.memtable, &self.segments_newest_first, key)
            .map_err(|source| Error::FactStoreIo { source })
    }

    fn put(&mut self, key: Vec<u8>, value: Vec<u8>) -> PoneResult<()> {
        self.wal
            .append_value(&key, &value)
            .map_err(|source| Error::FactStoreIo { source })?;
        self.memtable.insert(key, value);
        Ok(())
    }

    fn delete(&mut self, key: Vec<u8>) -> PoneResult<()> {
        self.wal
            .append_tombstone(&key)
            .map_err(|source| Error::FactStoreIo { source })?;
        self.memtable.delete(key);
        Ok(())
    }

    fn flush_memtable(&mut self) -> PoneResult<()> {
        if self.memtable.approximate_size() == 0 {
            return Ok(());
        }
        self.wal
            .sync()
            .map_err(|source| Error::FactStoreIo { source })?;
        let filename = self.manifest.allocate_segment();
        let path = self.dir.join(&filename);
        let reader = sst::write_memtable(&path, &self.memtable)
            .map_err(|source| Error::FactStoreIo { source })?;
        self.manifest.add_newest_segment(filename);
        self.manifest
            .save(&self.dir)
            .map_err(|source| Error::FactStoreIo { source })?;
        self.segments_newest_first.insert(0, reader);
        self.memtable = Memtable::new();
        self.wal
            .reset()
            .map_err(|source| Error::FactStoreIo { source })?;
        Ok(())
    }
}

fn same_tuple(left: &Fact, right: &Fact) -> bool {
    left.source == right.source
        && left.entity == right.entity
        && left.field == right.field
        && left.value == right.value
}

fn active_tuple_key(fact: &Fact) -> Vec<u8> {
    key::active_field_key(&fact.field, &fact.entity, &fact.value)
}

fn active_index_keys(active: &ActiveFact) -> [Vec<u8>; 3] {
    [
        key::active_field_key(&active.field, &active.entity, &active.value),
        key::active_entity_key(&active.entity, &active.field, &active.value),
        key::active_value_key(&active.field, &active.value, &active.entity),
    ]
}

fn send_rows<T: Send + 'static>(rows: Vec<PoneResult<T>>) -> mpsc::Receiver<PoneResult<T>> {
    let (tx, rx) = mpsc::channel(rows.len().max(1));
    tokio::spawn(async move {
        for row in rows {
            if tx.send(row).await.is_err() {
                break;
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::LsmFactStore;
    use poneglyph::{ActiveFilter, Filter, Store, Value, fact, retraction, uri};

    #[tokio::test]
    async fn lsm_fact_store_states_and_queries_active_facts() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        let fact = fact!(
            uri!("wiki:page:luffy"),
            uri!("wiki:title"),
            Value::text("Monkey D. Luffy")
        );
        store
            .state_facts_vec(vec![fact.clone()])
            .await
            .expect("state");

        let mut active = store
            .get_active_facts(ActiveFilter::ByField(uri!("wiki:title")))
            .await
            .expect("active");
        let first = active.recv().await.expect("first").expect("active fact");
        assert_eq!(first.entity, fact.entity);
        assert_eq!(first.value, fact.value);
        assert!(active.recv().await.is_none());

        let mut facts = store
            .get_facts(Filter::ByEntityUri(uri!("wiki:page:luffy")))
            .await
            .expect("facts");
        assert_eq!(
            facts.recv().await.expect("fact").expect("fact").entity,
            fact.entity
        );
    }

    #[tokio::test]
    async fn lsm_fact_store_reopens_wal_and_flushed_segments() {
        let tempdir = tempdir().expect("tempdir");
        let fact = fact!(uri!("e:one"), uri!("f:name"), Value::text("one"));
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        store
            .state_facts_vec(vec![fact.clone()])
            .await
            .expect("state");
        drop(store);

        let store = LsmFactStore::open(tempdir.path()).expect("reopen wal");
        let mut rows = store
            .get_active_facts(ActiveFilter::ByEntity(uri!("e:one")))
            .await
            .expect("active");
        assert_eq!(
            rows.recv().await.expect("row").expect("row").field,
            uri!("f:name")
        );
        store.flush().expect("flush");
        drop(store);

        let store = LsmFactStore::open(tempdir.path()).expect("reopen sst");
        let mut rows = store
            .get_active_facts(ActiveFilter::ByFieldEntityValue {
                field: uri!("f:name"),
                entity: uri!("e:one"),
                value: Value::text("one"),
            })
            .await
            .expect("active");
        assert!(rows.recv().await.expect("row").is_ok());
    }

    #[tokio::test]
    async fn lsm_fact_store_retracts_active_fact() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        let fact = fact!(uri!("e:one"), uri!("f:name"), Value::text("one"));
        let retract = retraction!(uri!("e:one"), uri!("f:name"), Value::text("one"));
        store.state_facts_vec(vec![fact]).await.expect("state");
        store.state_facts_vec(vec![retract]).await.expect("retract");

        let mut rows = store
            .get_active_facts(ActiveFilter::ByEntity(uri!("e:one")))
            .await
            .expect("active");
        assert!(rows.recv().await.is_none());
    }
}
