use std::path::{Path, PathBuf};
use std::{fs::File, io::Read};

use chrono::{DateTime, Utc};
use derive_builder::Builder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use poneglyph::Fact;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio::time::{Duration, interval};
use tracing::{debug, info, warn};

use crate::{CtlError, CtlResult, CtlStore, FilesystemConnection};

use super::ingestor::{FilesystemFileSnapshot, file_facts, root_facts};
use super::schema::FilesystemSchema;

const MAX_SCANNED_ENTRIES: usize = 25_000;
const DEFAULT_FULL_SCAN_INTERVAL_SECONDS: u64 = 300;
const DEFAULT_EVENT_DEBOUNCE_MILLIS: u64 = 1500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct FilesystemConfig {
    #[serde(default)]
    #[builder(default)]
    pub enabled: bool,
    #[serde(default = "default_full_scan_interval_seconds")]
    #[builder(default = "default_full_scan_interval_seconds()")]
    pub full_scan_interval_seconds: u64,
    #[serde(default = "default_event_debounce_millis")]
    #[builder(default = "default_event_debounce_millis()")]
    pub event_debounce_millis: u64,
}

#[derive(Debug)]
pub struct FilesystemConnector {
    config: FilesystemConfig,
}

impl FilesystemConnector {
    pub fn init(config: FilesystemConfig) -> CtlResult<Self> {
        Ok(Self { config })
    }

    pub fn name(&self) -> &'static str {
        "filesystem"
    }

    pub fn schema_namespace(&self) -> &'static str {
        "filesystem"
    }

    pub fn schema_facts(&self) -> Vec<Fact> {
        FilesystemSchema::facts()
    }

    pub fn config(&self) -> &FilesystemConfig {
        &self.config
    }

    pub async fn run(self, ctl: CtlStore, fact_tx: mpsc::Sender<Vec<Fact>>) -> CtlResult<()> {
        if !self.config.enabled {
            info!("filesystem connector is disabled");
            return Ok(());
        }

        let connections = ctl.list_filesystem_connections().await?;
        if connections.is_empty() {
            info!("filesystem connector has no configured roots");
            return Ok(());
        }

        let mut by_id = std::collections::HashMap::new();
        for connection in connections {
            by_id.insert(connection.id, connection);
        }

        for connection in by_id.values() {
            let facts = scan_connection(&ctl, connection).await?;
            emit_facts(&fact_tx, facts).await?;
        }
        info!("filesystem connector initial scan completed");

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let mut watcher = build_watcher(event_tx)?;
        for connection in by_id.values() {
            let root = PathBuf::from(connection.canonical_root_path.as_str());
            watcher
                .watch(root.as_path(), RecursiveMode::Recursive)
                .map_err(|error| CtlError::StoreQuery(error.to_string()))?;
        }
        info!(
            watched_roots = by_id.len(),
            "filesystem connector watcher started"
        );

        let mut full_scan_tick = interval(Duration::from_secs(
            self.config.full_scan_interval_seconds.max(15),
        ));
        let mut event_flush_tick = interval(Duration::from_millis(
            self.config.event_debounce_millis.max(250),
        ));
        let mut pending_connections = std::collections::BTreeSet::new();

        loop {
            tokio::select! {
                maybe_path = event_rx.recv() => {
                    if let Some(path) = maybe_path {
                        mark_pending_from_path(path.as_path(), by_id.values(), &mut pending_connections);
                    } else {
                        warn!("filesystem watcher event channel closed");
                        break;
                    }
                }
                _ = event_flush_tick.tick() => {
                    if pending_connections.is_empty() {
                        continue;
                    }
                    let ids = pending_connections.iter().copied().collect::<Vec<_>>();
                    pending_connections.clear();
                    for id in ids {
                        if let Some(connection) = by_id.get(&id) {
                            let facts = scan_connection(&ctl, connection).await?;
                            emit_facts(&fact_tx, facts).await?;
                        }
                    }
                }
                _ = full_scan_tick.tick() => {
                    for connection in by_id.values() {
                        let facts = scan_connection(&ctl, connection).await?;
                        emit_facts(&fact_tx, facts).await?;
                    }
                    debug!("filesystem connector completed periodic full scan");
                }
            }
        }

        Ok(())
    }
}

fn build_watcher(event_tx: mpsc::UnboundedSender<PathBuf>) -> CtlResult<RecommendedWatcher> {
    notify::recommended_watcher(move |result: notify::Result<notify::Event>| match result {
        Ok(event) => {
            for path in event.paths {
                let _ = event_tx.send(path);
            }
        }
        Err(error) => {
            warn!(%error, "filesystem watcher event error");
        }
    })
    .map_err(|error| CtlError::StoreQuery(error.to_string()))
}

fn mark_pending_from_path<'a>(
    path: &Path,
    connections: impl Iterator<Item = &'a FilesystemConnection>,
    pending_connections: &mut std::collections::BTreeSet<i64>,
) {
    for connection in connections {
        let root = PathBuf::from(connection.canonical_root_path.as_str());
        if path.starts_with(root.as_path()) {
            pending_connections.insert(connection.id);
        }
    }
}

async fn scan_connection(
    ctl: &CtlStore,
    connection: &FilesystemConnection,
) -> CtlResult<Vec<Fact>> {
    info!(
        connection_id = connection.id,
        root_path = %connection.root_path,
        "filesystem connector scanning root"
    );
    let mut snapshots = scan_root(connection.root_path.as_str());
    for snapshot in &mut snapshots {
        if snapshot.is_dir {
            continue;
        }
        let previous_content_hash = ctl
            .filesystem_path_state(connection.id, snapshot.relative_path.as_str())
            .await?
            .and_then(|state| state.last_content_hash);
        snapshot.previous_content_hash = previous_content_hash;
        let _ = ctl
            .save_filesystem_path_state(
                connection.id,
                snapshot.relative_path.as_str(),
                snapshot.content_hash.as_deref(),
            )
            .await?;
    }
    if snapshots.is_empty() {
        warn!(
            connection_id = connection.id,
            root_path = %connection.root_path,
            "filesystem connector found no readable files"
        );
    } else {
        debug!(
            connection_id = connection.id,
            file_count = snapshots.len(),
            "filesystem connector scanned files"
        );
    }
    let mut facts = Vec::new();
    facts.extend(root_facts(
        connection.id,
        connection.name.as_str(),
        connection.root_path.as_str(),
    ));
    facts.extend(file_facts(
        connection.id,
        connection.root_path.as_str(),
        snapshots.as_slice(),
    ));
    Ok(facts)
}

async fn emit_facts(fact_tx: &mpsc::Sender<Vec<Fact>>, facts: Vec<Fact>) -> CtlResult<()> {
    if facts.is_empty() {
        return Ok(());
    }
    debug!(
        fact_count = facts.len(),
        "filesystem connector emitting fact batch"
    );
    fact_tx
        .send(facts)
        .await
        .map_err(|error| CtlError::StoreQuery(error.to_string()))
}

fn scan_root(root_path: &str) -> Vec<FilesystemFileSnapshot> {
    let root = PathBuf::from(root_path);
    let root_abs = match root.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            warn!(root_path, %error, "filesystem connector failed to canonicalize root");
            return Vec::new();
        }
    };
    if !root_abs.is_dir() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut stack = vec![root_abs.clone()];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                debug!(path = %current.display(), %error, "filesystem connector skipped unreadable directory");
                continue;
            }
        };

        for entry in entries.flatten() {
            if out.len() >= MAX_SCANNED_ENTRIES {
                warn!(
                    root_path,
                    max_entries = MAX_SCANNED_ENTRIES,
                    "filesystem connector reached scan entry limit"
                );
                return out;
            }
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let is_dir = metadata.is_dir();
            if is_dir {
                stack.push(path.clone());
            }

            let absolute_path = path.to_string_lossy().to_string();
            let relative_path = path
                .strip_prefix(&root_abs)
                .ok()
                .and_then(Path::to_str)
                .map(str::to_string)
                .unwrap_or(absolute_path.clone());
            let modified_at = metadata.modified().ok().map(DateTime::<Utc>::from);
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_string);
            let content_hash = if is_dir {
                None
            } else {
                hash_file(path.as_path()).ok()
            };

            out.push(FilesystemFileSnapshot {
                relative_path,
                absolute_path,
                is_dir,
                size_bytes: if is_dir { None } else { Some(metadata.len()) },
                modified_at,
                extension,
                content_hash,
                previous_content_hash: None,
            });
        }
    }

    out
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn default_full_scan_interval_seconds() -> u64 {
    DEFAULT_FULL_SCAN_INTERVAL_SECONDS
}

fn default_event_debounce_millis() -> u64 {
    DEFAULT_EVENT_DEBOUNCE_MILLIS
}
