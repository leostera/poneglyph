#![allow(dead_code)]

mod key;
mod manifest;
mod memtable;
mod merge;
mod sst;
mod wal;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use poneglyph::facts::store::{new_tx_id, sort_facts, validate_pending_fact};
use poneglyph::schema::{SchemaDefinition, SchemaSnapshot};
use poneglyph::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, Store, Uri, Value};
use tokio::sync::mpsc;

use self::manifest::Manifest;
use self::memtable::Memtable;
use self::sst::SstReader;
use self::wal::Wal;

const WAL_FILE: &str = "facts.wal";
const FLUSH_THRESHOLD_BYTES: usize = 128 * 1024 * 1024;

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
    active_cache: HashMap<Vec<u8>, ActiveFact>,
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
                active_cache: HashMap::new(),
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
        self.inner
            .lock()
            .expect("LSM mutex poisoned")
            .repair_active_indexes()
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

    fn get_active_facts(
        &mut self,
        filter: ActiveFilter,
    ) -> PoneResult<Vec<PoneResult<ActiveFact>>> {
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
        self.scan_entries(prefix).map(|rows| {
            let mut uri_cache = HashMap::new();
            rows.into_iter()
                .map(|(key, bytes)| {
                    if let Some(active) = self.active_cache.get(&key) {
                        return Ok(active.clone());
                    }
                    let active = decode_active_fact_with_cache(&bytes, &mut uri_cache)?;
                    self.active_cache.insert(key, active.clone());
                    Ok(active)
                })
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
                self.active_cache.remove(&key);
                self.delete(key)?;
            }
        } else {
            let bytes = encode_active_fact(&active)?;
            for key in keys {
                self.active_cache.insert(key.clone(), active.clone());
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
            .map(|bytes| decode_active_fact(&bytes))
            .collect::<PoneResult<Vec<_>>>()?
            .into_iter()
            .map(|active| key::active_field_key(&active.field, &active.entity, &active.value))
            .collect())
    }

    fn repair_active_indexes(&mut self) -> PoneResult<()> {
        let existing = self
            .scan_values(key::active_all_prefix())?
            .into_iter()
            .map(|bytes| decode_active_fact(&bytes))
            .collect::<PoneResult<Vec<_>>>()?;
        for active in existing {
            for key in active_index_keys(&active) {
                self.delete(key)?;
            }
        }

        let mut facts = self
            .scan_facts(key::log_all_prefix())?
            .into_iter()
            .collect::<PoneResult<Vec<_>>>()?;
        facts.sort_by(|left, right| {
            left.stated_at
                .cmp(&right.stated_at)
                .then_with(|| left.fact_id.as_str().cmp(right.fact_id.as_str()))
        });

        let mut active = std::collections::BTreeMap::new();
        for fact in facts {
            let tuple_key = active_tuple_key(&fact);
            if fact.retraction {
                active.remove(&tuple_key);
            } else {
                active.insert(tuple_key, fact);
            }
        }

        for fact in active.into_values() {
            self.apply_active_indexes(&fact)?;
        }
        self.wal
            .sync()
            .map_err(|source| Error::FactStoreIo { source })?;
        Ok(())
    }

    fn scan_facts(&self, prefix: Vec<u8>) -> PoneResult<Vec<PoneResult<Fact>>> {
        self.scan_values(prefix).map(|rows| {
            rows.into_iter()
                .map(|bytes| serde_json::from_slice(&bytes).map_err(Error::from))
                .collect()
        })
    }

    fn scan_values(&self, prefix: Vec<u8>) -> PoneResult<Vec<Vec<u8>>> {
        self.scan_entries(prefix)
            .map(|rows| rows.into_iter().map(|(_, value)| value).collect())
    }

    fn scan_entries(&self, prefix: Vec<u8>) -> PoneResult<Vec<(Vec<u8>, Vec<u8>)>> {
        merge::scan_prefix_merged(&self.memtable, &self.segments_newest_first, &prefix)
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

fn encode_active_fact(active: &ActiveFact) -> PoneResult<Vec<u8>> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(b"PLA1");
    push_component(&mut out, active.source.as_str())?;
    push_component(&mut out, active.entity.as_str())?;
    push_component(&mut out, active.field.as_str())?;
    push_value_component(&mut out, &active.value)?;
    push_component(&mut out, active.fact_id.as_str())?;
    push_component(&mut out, active.tx_id.as_str())?;
    Ok(out)
}

fn decode_active_fact(bytes: &[u8]) -> PoneResult<ActiveFact> {
    decode_active_fact_with_cache(bytes, &mut HashMap::new())
}

fn decode_active_fact_with_cache(
    bytes: &[u8],
    uri_cache: &mut HashMap<String, Uri>,
) -> PoneResult<ActiveFact> {
    if !bytes.starts_with(b"PLA1") {
        return Ok(serde_json::from_slice(bytes)?);
    }
    let mut cursor = 4;
    let source = read_uri_component(bytes, &mut cursor, uri_cache)?;
    let entity = read_uri_component(bytes, &mut cursor, uri_cache)?;
    let field = read_uri_component(bytes, &mut cursor, uri_cache)?;
    let value = read_value_component(bytes, &mut cursor, uri_cache)?;
    let fact_id = read_uri_component(bytes, &mut cursor, uri_cache)?;
    let tx_id = read_uri_component(bytes, &mut cursor, uri_cache)?;
    Ok(ActiveFact {
        source,
        entity,
        field,
        value,
        fact_id,
        tx_id,
    })
}

fn push_component(out: &mut Vec<u8>, value: &str) -> PoneResult<()> {
    let len = u32::try_from(value.len()).map_err(|source| Error::FactStoreIo {
        source: std::io::Error::new(std::io::ErrorKind::InvalidInput, source),
    })?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(value.as_bytes());
    Ok(())
}

fn push_value_component(out: &mut Vec<u8>, value: &Value) -> PoneResult<()> {
    match value {
        Value::Null => out.push(0),
        Value::Text(value) => {
            out.push(1);
            push_component(out, value)?;
        }
        Value::Number(value) => {
            out.push(2);
            push_component(out, value)?;
        }
        Value::Boolean(value) => {
            out.push(3);
            out.push(u8::from(*value));
        }
        Value::Reference(value) => {
            out.push(5);
            push_component(out, value.as_str())?;
        }
        _ => {
            out.push(255);
            push_component(out, &serde_json::to_string(value)?)?;
        }
    }
    Ok(())
}

fn read_value_component(
    bytes: &[u8],
    cursor: &mut usize,
    uri_cache: &mut HashMap<String, Uri>,
) -> PoneResult<Value> {
    if *cursor >= bytes.len() {
        return Err(Error::FactStoreIo {
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "missing active fact value tag",
            ),
        });
    }
    let tag = bytes[*cursor];
    *cursor += 1;
    match tag {
        0 => Ok(Value::Null),
        1 => Ok(Value::Text(read_component(bytes, cursor)?.to_string())),
        2 => Ok(Value::Number(read_component(bytes, cursor)?.to_string())),
        3 => {
            if *cursor >= bytes.len() {
                return Err(Error::FactStoreIo {
                    source: std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "missing active fact boolean value",
                    ),
                });
            }
            let value = bytes[*cursor] != 0;
            *cursor += 1;
            Ok(Value::Boolean(value))
        }
        5 => Ok(Value::Reference(read_uri_component(
            bytes, cursor, uri_cache,
        )?)),
        255 => Ok(serde_json::from_str(read_component(bytes, cursor)?)?),
        _ => Err(Error::FactStoreIo {
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid active fact value tag",
            ),
        }),
    }
}

fn read_uri_component(
    bytes: &[u8],
    cursor: &mut usize,
    uri_cache: &mut HashMap<String, Uri>,
) -> PoneResult<Uri> {
    let value = read_component(bytes, cursor)?;
    if let Some(uri) = uri_cache.get(value) {
        return Ok(uri.clone());
    }
    let uri = Uri::parse(value)?;
    uri_cache.insert(value.to_string(), uri.clone());
    Ok(uri)
}

fn read_component<'a>(bytes: &'a [u8], cursor: &mut usize) -> PoneResult<&'a str> {
    if bytes.len().saturating_sub(*cursor) < 4 {
        return Err(Error::FactStoreIo {
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "truncated active fact component length",
            ),
        });
    }
    let len = u32::from_be_bytes(bytes[*cursor..*cursor + 4].try_into().expect("length")) as usize;
    *cursor += 4;
    let end = (*cursor).saturating_add(len);
    if end > bytes.len() {
        return Err(Error::FactStoreIo {
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "truncated active fact component",
            ),
        });
    }
    let value = std::str::from_utf8(&bytes[*cursor..end]).map_err(|source| Error::FactStoreIo {
        source: std::io::Error::new(std::io::ErrorKind::InvalidData, source),
    })?;
    *cursor = end;
    Ok(value)
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
    for row in rows {
        if tx.try_send(row).is_err() {
            break;
        }
    }
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
