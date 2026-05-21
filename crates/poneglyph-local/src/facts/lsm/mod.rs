#![allow(dead_code)]

mod key;
mod manifest;
mod memtable;
mod merge;
mod sst;
mod wal;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use poneglyph::facts::store::{new_tx_id, sort_facts, validate_pending_fact};
use poneglyph::schema::{SchemaDefinition, SchemaSnapshot};
use poneglyph::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, Store, Uri, Value};
use tokio::sync::mpsc;

use self::manifest::{Manifest, ManifestEdit, SegmentMetadata};
use self::memtable::Memtable;
use self::sst::SstReader;
use self::wal::Wal;

const WAL_FILE: &str = "facts.wal";
const DEFAULT_FLUSH_THRESHOLD_BYTES: usize = 128 * 1024 * 1024;
const FLUSH_THRESHOLD_ENV: &str = "PONEGLYPH_LSM_FLUSH_THRESHOLD_BYTES";
const ACTIVE_CACHE_LIMIT_ENV: &str = "PONEGLYPH_LSM_ACTIVE_CACHE_MAX_ENTRIES";
const L0_COMPACTION_SEGMENTS_ENV: &str = "PONEGLYPH_LSM_L0_COMPACTION_SEGMENTS";
const DEFAULT_L0_COMPACTION_SEGMENTS: usize = 16;

#[derive(Clone)]
pub struct LsmFactStore {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LsmStats {
    pub active_requests: u64,
    pub active_rows_scanned: u64,
    pub active_cache_hits: u64,
    pub active_cache_misses: u64,
    pub active_rows_decoded: u64,
}

struct Inner {
    dir: PathBuf,
    manifest: Manifest,
    memtable: Memtable,
    wal: Wal,
    segments_newest_first: Vec<SstReader>,
    active_cache: HashMap<Vec<u8>, ActiveFact>,
    active_cache_max_entries: Option<usize>,
    flush_threshold_bytes: usize,
    l0_compaction_segments: usize,
    stats: LsmStats,
}

impl LsmFactStore {
    pub fn open(path: impl AsRef<Path>) -> PoneResult<Self> {
        let dir = path.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|source| Error::FactStoreIo { source })?;
        let manifest = Manifest::load(&dir).map_err(|source| Error::FactStoreIo { source })?;
        let segments_newest_first = open_manifest_segments(&manifest, &dir)
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
                active_cache_max_entries: active_cache_max_entries_from_env(),
                flush_threshold_bytes: flush_threshold_bytes_from_env(),
                l0_compaction_segments: l0_compaction_segments_from_env(),
                stats: LsmStats::default(),
            })),
        })
    }

    pub fn flush(&self) -> PoneResult<()> {
        self.inner
            .lock()
            .expect("LSM mutex poisoned")
            .flush_memtable()
    }

    pub fn compact(&self) -> PoneResult<()> {
        self.inner
            .lock()
            .expect("LSM mutex poisoned")
            .compact_segments()
    }

    pub fn needs_compaction(&self) -> bool {
        let inner = self.inner.lock().expect("LSM mutex poisoned");
        inner
            .manifest
            .compaction_plan_with_l0_threshold(inner.l0_compaction_segments)
            .is_some()
    }

    pub fn prewarm_active_cache(&self) -> PoneResult<usize> {
        self.inner
            .lock()
            .expect("LSM mutex poisoned")
            .prewarm_active_cache()
    }

    pub fn stats(&self) -> LsmStats {
        self.inner.lock().expect("LSM mutex poisoned").stats
    }

    pub fn reset_stats(&self) {
        self.inner.lock().expect("LSM mutex poisoned").stats = LsmStats::default();
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
        if self.memtable.approximate_size() >= self.flush_threshold_bytes {
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
        let rows = self.scan_entries(prefix)?;
        self.stats.active_requests += 1;
        self.stats.active_rows_scanned += rows.len() as u64;
        let mut uri_cache = HashMap::new();
        let active = rows
            .into_iter()
            .map(|(key, bytes)| {
                if let Some(active) = self.active_cache.get(&key) {
                    self.stats.active_cache_hits += 1;
                    return Ok(active.clone());
                }
                self.stats.active_cache_misses += 1;
                self.stats.active_rows_decoded += 1;
                let active = decode_active_fact_with_cache(&bytes, &mut uri_cache)?;
                self.cache_active_fact(key, active.clone());
                Ok(active)
            })
            .collect::<PoneResult<Vec<_>>>()?;
        Ok(active.into_iter().map(Ok).collect())
    }

    fn prewarm_active_cache(&mut self) -> PoneResult<usize> {
        let rows = self.scan_entries(key::active_all_prefix())?;
        let mut uri_cache = HashMap::new();
        for (key, bytes) in rows {
            if !self.active_cache.contains_key(&key) {
                let active = decode_active_fact_with_cache(&bytes, &mut uri_cache)?;
                self.stats.active_rows_decoded += 1;
                self.cache_active_fact(key, active);
            }
        }
        Ok(self.active_cache.len())
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
                self.cache_active_fact(key.clone(), active.clone());
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

    fn cache_active_fact(&mut self, key: Vec<u8>, active: ActiveFact) {
        if let Some(max_entries) = self.active_cache_max_entries
            && self.active_cache.len() >= max_entries
        {
            self.active_cache.clear();
        }
        self.active_cache.insert(key, active);
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

    fn compact_segments(&mut self) -> PoneResult<()> {
        self.flush_memtable()?;
        if self.segments_newest_first.len() <= 1 {
            return Ok(());
        }

        if let Some(plan) = self
            .manifest
            .compaction_plan_with_l0_threshold(self.l0_compaction_segments)
        {
            let input_set = plan
                .inputs_newest_first
                .iter()
                .cloned()
                .collect::<HashSet<_>>();
            let input_readers = self
                .manifest
                .segments_newest_first
                .iter()
                .zip(self.segments_newest_first.iter())
                .filter_map(|(filename, reader)| {
                    input_set.contains(filename).then_some(reader.clone())
                })
                .collect::<Vec<_>>();
            let older_readers = self
                .manifest
                .segments_newest_first
                .iter()
                .zip(self.segments_newest_first.iter())
                .filter_map(|(filename, reader)| {
                    (!input_set.contains(filename)).then_some(reader.clone())
                })
                .collect::<Vec<_>>();
            return self.compact_readers(
                plan.inputs_newest_first,
                &input_readers,
                &older_readers,
                plan.output_level,
                true,
            );
        }

        let previous_segments = self.manifest.segments_newest_first.clone();
        let readers = self.segments_newest_first.clone();
        self.compact_readers(previous_segments, &readers, &[], 0, false)
    }

    fn compact_readers(
        &mut self,
        removed: Vec<String>,
        readers: &[SstReader],
        older_readers: &[SstReader],
        output_level: u32,
        preserve_tombstones: bool,
    ) -> PoneResult<()> {
        let filename = self.manifest.allocate_segment();
        let path = self.dir.join(&filename);
        let mut compacted = Memtable::new();
        if preserve_tombstones {
            for (key, entry) in merge::scan_prefix_entries_merged(&Memtable::new(), readers, &[])
                .map_err(|source| Error::FactStoreIo { source })?
            {
                match entry {
                    self::memtable::MemtableEntry::Value(value) => compacted.insert(key, value),
                    self::memtable::MemtableEntry::Tombstone => {
                        if should_preserve_tombstone(&key, older_readers) {
                            compacted.delete(key);
                        }
                    }
                }
            }
        } else {
            for (key, value) in merge::scan_prefix_merged(&Memtable::new(), readers, &[])
                .map_err(|source| Error::FactStoreIo { source })?
            {
                compacted.insert(key, value);
            }
        }
        let reader = sst::write_memtable(&path, &compacted)
            .map_err(|source| Error::FactStoreIo { source })?;

        let metadata = segment_metadata(filename, &reader, output_level);
        self.manifest
            .persist_edit(
                &self.dir,
                ManifestEdit::ReplaceSegments {
                    removed: removed.clone(),
                    added: vec![metadata],
                },
            )
            .map_err(|source| Error::FactStoreIo { source })?;
        self.segments_newest_first = open_manifest_segments(&self.manifest, &self.dir)
            .map_err(|source| Error::FactStoreIo { source })?;
        for segment in removed {
            let path = self.dir.join(segment);
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(source) => return Err(Error::FactStoreIo { source }),
            }
        }
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
        let metadata = segment_metadata(filename, &reader, 0);
        self.manifest
            .persist_edit(&self.dir, ManifestEdit::AddSegment(metadata))
            .map_err(|source| Error::FactStoreIo { source })?;
        self.segments_newest_first.insert(0, reader);
        self.memtable = Memtable::new();
        self.wal
            .reset()
            .map_err(|source| Error::FactStoreIo { source })?;
        Ok(())
    }
}

fn should_preserve_tombstone(key: &[u8], older_readers: &[SstReader]) -> bool {
    if !key::is_active_key(key) {
        return true;
    }
    older_readers
        .iter()
        .any(|reader| reader.may_contain_key(key))
}

fn open_manifest_segments(
    manifest: &Manifest,
    dir: &std::path::Path,
) -> std::io::Result<Vec<SstReader>> {
    manifest
        .segments_with_metadata_newest_first(dir)
        .into_iter()
        .map(|(path, metadata)| {
            SstReader::open_with_bounds(
                path,
                metadata.and_then(|metadata| metadata.smallest_key.clone()),
                metadata.and_then(|metadata| metadata.largest_key.clone()),
            )
        })
        .collect()
}

fn segment_metadata(filename: String, reader: &sst::SstReader, level: u32) -> SegmentMetadata {
    let (smallest_key, largest_key) = reader
        .key_bounds()
        .map(|(smallest, largest)| (Some(smallest.to_vec()), Some(largest.to_vec())))
        .unwrap_or((None, None));
    SegmentMetadata {
        filename,
        level,
        smallest_key,
        largest_key,
        file_size_bytes: Some(reader.file_size_bytes()),
    }
}

fn active_cache_max_entries_from_env() -> Option<usize> {
    parse_optional_usize_env(ACTIVE_CACHE_LIMIT_ENV)
}

fn flush_threshold_bytes_from_env() -> usize {
    parse_optional_usize_env(FLUSH_THRESHOLD_ENV).unwrap_or(DEFAULT_FLUSH_THRESHOLD_BYTES)
}

fn l0_compaction_segments_from_env() -> usize {
    parse_optional_usize_env(L0_COMPACTION_SEGMENTS_ENV).unwrap_or(DEFAULT_L0_COMPACTION_SEGMENTS)
}

fn parse_optional_usize_env(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
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

    use super::{
        LsmFactStore, ManifestEdit, encode_active_fact, key, merge, parse_optional_usize_env,
        segment_metadata, sst,
    };
    use crate::facts::lsm::memtable::Memtable;
    use poneglyph::{ActiveFact, ActiveFilter, Filter, Store, Value, fact, retraction, uri};

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

    #[test]
    fn lsm_parse_optional_usize_env_ignores_missing_or_invalid_values() {
        assert_eq!(parse_optional_usize_env("PONEGLYPH_TEST_MISSING"), None);
    }

    #[tokio::test]
    async fn lsm_flush_records_segment_metadata_bounds() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        store
            .state_facts_vec(vec![fact!(
                uri!("e:one"),
                uri!("f:name"),
                Value::text("one")
            )])
            .await
            .expect("state");
        store.flush().expect("flush");

        let inner = store.inner.lock().expect("lock");
        let segment = inner.manifest.levels[0].first().expect("segment metadata");
        assert!(segment.smallest_key.is_some());
        assert!(segment.largest_key.is_some());
        assert!(segment.file_size_bytes.is_some_and(|size| size > 0));
    }

    #[tokio::test]
    async fn lsm_fact_store_supports_optional_active_cache_bound() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        let mut inner = store.inner.lock().expect("lock");
        inner.active_cache_max_entries = Some(1);
        let first = ActiveFact {
            source: uri!("source:one"),
            entity: uri!("entity:one"),
            field: uri!("field:name"),
            value: Value::text("one"),
            fact_id: uri!("fact:one"),
            tx_id: uri!("tx:one"),
        };
        let second = ActiveFact {
            source: uri!("source:one"),
            entity: uri!("entity:two"),
            field: uri!("field:name"),
            value: Value::text("two"),
            fact_id: uri!("fact:two"),
            tx_id: uri!("tx:one"),
        };

        inner.cache_active_fact(b"one".to_vec(), first);
        assert_eq!(inner.active_cache.len(), 1);
        inner.cache_active_fact(b"two".to_vec(), second);
        assert_eq!(inner.active_cache.len(), 1);
        assert!(inner.active_cache.contains_key(&b"two".to_vec()));
    }

    #[tokio::test]
    async fn lsm_fact_store_tracks_active_cache_stats() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        let fact = fact!(uri!("e:one"), uri!("f:name"), Value::text("one"));
        store.state_facts_vec(vec![fact]).await.expect("state");
        store.reset_stats();

        for _ in 0..2 {
            let mut rows = store
                .get_active_facts(ActiveFilter::ByField(uri!("f:name")))
                .await
                .expect("active");
            assert!(rows.recv().await.expect("row").is_ok());
        }

        let stats = store.stats();
        assert_eq!(stats.active_requests, 2);
        assert_eq!(stats.active_rows_scanned, 2);
        assert_eq!(stats.active_cache_hits, 2);
        assert_eq!(stats.active_cache_misses, 0);
    }

    #[tokio::test]
    async fn lsm_fact_store_prewarms_active_cache_after_reopen() {
        let tempdir = tempdir().expect("tempdir");
        let fact = fact!(uri!("e:one"), uri!("f:name"), Value::text("one"));
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        store.state_facts_vec(vec![fact]).await.expect("state");
        store.flush().expect("flush");
        drop(store);

        let store = LsmFactStore::open(tempdir.path()).expect("reopen");
        let warmed = store.prewarm_active_cache().expect("prewarm");
        assert_eq!(warmed, 1, "prewarm loads the primary active/field index");
        let mut rows = store
            .get_active_facts(ActiveFilter::ByField(uri!("f:name")))
            .await
            .expect("active");
        assert!(rows.recv().await.expect("row").is_ok());
    }

    #[tokio::test]
    async fn lsm_fact_store_reports_planned_l0_compaction() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        store.inner.lock().expect("lock").l0_compaction_segments = 4;
        for index in 0..4 {
            store
                .state_facts_vec(vec![fact!(
                    uri!(format!("e:{index}")),
                    uri!("f:name"),
                    Value::text(format!("{index}"))
                )])
                .await
                .expect("state");
            store.flush().expect("flush");
        }
        assert!(!store.needs_compaction());

        store
            .state_facts_vec(vec![fact!(
                uri!("e:five"),
                uri!("f:name"),
                Value::text("five")
            )])
            .await
            .expect("state");
        store.flush().expect("flush fifth");
        assert!(store.needs_compaction());
    }

    #[tokio::test]
    async fn lsm_fact_store_executes_planned_l0_compaction_to_level_one() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        store.inner.lock().expect("lock").l0_compaction_segments = 4;
        for index in 0..5 {
            store
                .state_facts_vec(vec![fact!(
                    uri!(format!("e:{index}")),
                    uri!("f:name"),
                    Value::text(format!("{index}"))
                )])
                .await
                .expect("state");
            store.flush().expect("flush");
        }
        assert!(store.needs_compaction());

        store.compact().expect("compact planned L0");
        let inner = store.inner.lock().expect("lock");
        assert_eq!(inner.manifest.levels[0].len(), 0);
        assert_eq!(inner.manifest.levels[1].len(), 1);
        assert!(
            !inner
                .manifest
                .compaction_plan_with_l0_threshold(inner.l0_compaction_segments)
                .is_some()
        );
        drop(inner);

        let mut rows = store
            .get_active_facts(ActiveFilter::ByField(uri!("f:name")))
            .await
            .expect("active");
        let mut count = 0;
        while let Some(row) = rows.recv().await {
            row.expect("row");
            count += 1;
        }
        assert_eq!(count, 5);
    }

    #[tokio::test]
    async fn lsm_fact_store_compacts_flushed_segments() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        let first = fact!(uri!("e:one"), uri!("f:name"), Value::text("one"));
        let second = fact!(uri!("e:two"), uri!("f:name"), Value::text("two"));
        store.state_facts_vec(vec![first]).await.expect("first");
        store.flush().expect("flush first");
        store.state_facts_vec(vec![second]).await.expect("second");
        store.flush().expect("flush second");

        assert_eq!(
            std::fs::read_dir(tempdir.path())
                .expect("read dir")
                .filter(|entry| entry
                    .as_ref()
                    .expect("entry")
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "sst"))
                .count(),
            2
        );
        store.compact().expect("compact");
        assert_eq!(
            std::fs::read_dir(tempdir.path())
                .expect("read dir")
                .filter(|entry| entry
                    .as_ref()
                    .expect("entry")
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "sst"))
                .count(),
            1
        );

        let mut rows = store
            .get_active_facts(ActiveFilter::ByField(uri!("f:name")))
            .await
            .expect("active");
        assert!(rows.recv().await.expect("row").is_ok());
        assert!(rows.recv().await.expect("row").is_ok());
        assert!(rows.recv().await.is_none());
    }

    #[tokio::test]
    async fn planned_l0_compaction_preserves_active_tombstones_over_older_levels() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        store.inner.lock().expect("lock").l0_compaction_segments = 4;
        let target = fact!(uri!("e:target"), uri!("f:name"), Value::text("target"));
        store
            .state_facts_vec(vec![target])
            .await
            .expect("state target");
        store.flush().expect("flush target");
        for index in 0..4 {
            store
                .state_facts_vec(vec![fact!(
                    uri!(format!("e:old:{index}")),
                    uri!("f:name"),
                    Value::text(format!("old {index}"))
                )])
                .await
                .expect("state old");
            store.flush().expect("flush old");
        }
        store.compact().expect("compact old L0 into L1");

        store
            .state_facts_vec(vec![retraction!(
                uri!("e:target"),
                uri!("f:name"),
                Value::text("target")
            )])
            .await
            .expect("retract target");
        store.flush().expect("flush retract");
        for index in 0..4 {
            store
                .state_facts_vec(vec![fact!(
                    uri!(format!("e:new:{index}")),
                    uri!("f:name"),
                    Value::text(format!("new {index}"))
                )])
                .await
                .expect("state new");
            store.flush().expect("flush new");
        }
        store.compact().expect("compact retraction L0 into L1");

        let mut rows = store
            .get_active_facts(ActiveFilter::ByEntity(uri!("e:target")))
            .await
            .expect("active");
        assert!(rows.recv().await.is_none());
        drop(store);

        let store = LsmFactStore::open(tempdir.path()).expect("reopen");
        let mut rows = store
            .get_active_facts(ActiveFilter::ByEntity(uri!("e:target")))
            .await
            .expect("active after reopen");
        assert!(rows.recv().await.is_none());
    }

    #[tokio::test]
    async fn reopen_ignores_sst_written_before_manifest_publish() {
        let tempdir = tempdir().expect("tempdir");
        let field = uri!("f:name");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        store
            .state_facts_vec(vec![fact!(
                uri!("e:kept"),
                field.clone(),
                Value::text("kept")
            )])
            .await
            .expect("state kept");
        store.flush().expect("flush kept");

        let stray_active = ActiveFact {
            source: uri!("source:stray"),
            entity: uri!("e:stray"),
            field: field.clone(),
            value: Value::text("stray"),
            fact_id: uri!("fact:stray"),
            tx_id: uri!("tx:stray"),
        };
        let mut stray = Memtable::new();
        stray.insert(
            key::active_field_key(
                &stray_active.field,
                &stray_active.entity,
                &stray_active.value,
            ),
            encode_active_fact(&stray_active).expect("encode active"),
        );
        sst::write_memtable(tempdir.path().join("99999999999999999999.sst"), &stray)
            .expect("write stray sst");
        drop(store);

        let store = LsmFactStore::open(tempdir.path()).expect("reopen");
        let mut rows = store
            .get_active_facts(ActiveFilter::ByEntity(uri!("e:stray")))
            .await
            .expect("stray active");
        assert!(rows.recv().await.is_none());
        let mut rows = store
            .get_active_facts(ActiveFilter::ByEntity(uri!("e:kept")))
            .await
            .expect("kept active");
        assert!(rows.recv().await.expect("kept").is_ok());
    }

    #[tokio::test]
    async fn reopen_honors_manifest_publish_before_obsolete_segment_deletion() {
        let tempdir = tempdir().expect("tempdir");
        let store = LsmFactStore::open(tempdir.path()).expect("open");
        for index in 0..5 {
            store
                .state_facts_vec(vec![fact!(
                    uri!(format!("e:{index}")),
                    uri!("f:name"),
                    Value::text(format!("{index}"))
                )])
                .await
                .expect("state");
            store.flush().expect("flush");
        }

        let obsolete_segments = {
            let mut inner = store.inner.lock().expect("lock");
            let removed = inner.manifest.segments_newest_first.clone();
            let rows = merge::scan_prefix_merged(
                &Memtable::new(),
                &inner.segments_newest_first.clone(),
                &[],
            )
            .expect("merge rows");
            let mut compacted = Memtable::new();
            for (key, value) in rows {
                compacted.insert(key, value);
            }
            let filename = inner.manifest.allocate_segment();
            let reader = sst::write_memtable(inner.dir.join(&filename), &compacted)
                .expect("write compacted");
            let metadata = segment_metadata(filename, &reader, 1);
            let dir = inner.dir.clone();
            inner
                .manifest
                .persist_edit(
                    &dir,
                    ManifestEdit::ReplaceSegments {
                        removed: removed.clone(),
                        added: vec![metadata],
                    },
                )
                .expect("publish manifest edit");
            removed
        };
        drop(store);
        for filename in &obsolete_segments {
            assert!(
                tempdir.path().join(filename).exists(),
                "obsolete file remains"
            );
        }

        let store = LsmFactStore::open(tempdir.path()).expect("reopen");
        let mut rows = store
            .get_active_facts(ActiveFilter::ByField(uri!("f:name")))
            .await
            .expect("active");
        let mut count = 0;
        while let Some(row) = rows.recv().await {
            row.expect("row");
            count += 1;
        }
        assert_eq!(count, 5);
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
