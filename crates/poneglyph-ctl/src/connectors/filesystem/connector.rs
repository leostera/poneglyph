use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use derive_builder::Builder;
use poneglyph::Fact;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::{CtlResult, CtlStore};

use super::ingestor::{FilesystemFileSnapshot, file_facts, root_facts};
use super::schema::FilesystemSchema;

const MAX_SCANNED_ENTRIES: usize = 25_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, Builder)]
#[builder(pattern = "owned")]
pub struct FilesystemConfig {
    #[serde(default)]
    #[builder(default)]
    pub enabled: bool,
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
        let connections = ctl.list_filesystem_connections().await?;
        if connections.is_empty() {
            info!("filesystem connector has no configured roots");
            return Ok(());
        }

        let mut facts = Vec::new();
        for connection in connections {
            info!(
                connection_id = connection.id,
                root_path = %connection.root_path,
                "filesystem connector scanning root"
            );
            let snapshots = scan_root(connection.root_path.as_str());
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
        }

        if facts.is_empty() {
            info!("filesystem connector produced no facts");
            return Ok(());
        }

        info!(
            fact_count = facts.len(),
            "filesystem connector emitting fact batch"
        );
        let _ = fact_tx.send(facts).await;
        Ok(())
    }
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

            out.push(FilesystemFileSnapshot {
                relative_path,
                absolute_path,
                is_dir,
                size_bytes: if is_dir { None } else { Some(metadata.len()) },
                modified_at,
                extension,
            });
        }
    }

    out
}
