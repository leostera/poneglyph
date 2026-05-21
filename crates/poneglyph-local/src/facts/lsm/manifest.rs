use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MANIFEST_FILE: &str = "MANIFEST.json";
const MANIFEST_EDIT_LOG_FILE: &str = "MANIFEST.log";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) next_file_number: u64,
    #[serde(default)]
    pub(crate) segments_newest_first: Vec<String>,
    #[serde(default)]
    pub(crate) levels: Vec<Vec<SegmentMetadata>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SegmentMetadata {
    pub(crate) filename: String,
    pub(crate) level: u32,
    pub(crate) smallest_key: Option<Vec<u8>>,
    pub(crate) largest_key: Option<Vec<u8>>,
    pub(crate) file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum ManifestEdit {
    AddSegment(SegmentMetadata),
    ReplaceSegments {
        removed: Vec<String>,
        added: Vec<SegmentMetadata>,
    },
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            next_file_number: 1,
            segments_newest_first: Vec::new(),
            levels: vec![Vec::new()],
        }
    }
}

impl Manifest {
    pub(crate) fn load(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref();
        let path = dir.join(MANIFEST_FILE);
        let mut manifest = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(invalid_data)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => return Err(error),
        };
        manifest.normalize();
        manifest.replay_edit_log(dir)?;
        manifest.normalize();
        Ok(manifest)
    }

    pub(crate) fn save(&self, dir: impl AsRef<Path>) -> io::Result<()> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        let path = dir.join(MANIFEST_FILE);
        let temp_path = dir.join("MANIFEST.json.tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(invalid_data)?;
        std::fs::write(&temp_path, bytes)?;
        std::fs::rename(temp_path, path)?;
        clear_edit_log(dir)?;
        Ok(())
    }

    pub(crate) fn persist_edit(
        &mut self,
        dir: impl AsRef<Path>,
        edit: ManifestEdit,
    ) -> io::Result<()> {
        let dir = dir.as_ref();
        append_edit_log(dir, &edit)?;
        self.apply_edit(edit);
        self.normalize();
        self.save(dir)
    }

    pub(crate) fn allocate_segment(&mut self) -> String {
        let number = self.next_file_number;
        self.next_file_number += 1;
        format!("{number:020}.sst")
    }

    pub(crate) fn add_newest_segment(&mut self, filename: String) {
        let metadata = SegmentMetadata::level_zero(filename);
        self.apply_edit(ManifestEdit::AddSegment(metadata));
        self.normalize();
    }

    pub(crate) fn replace_segments(&mut self, removed: Vec<String>, added: Vec<SegmentMetadata>) {
        self.apply_edit(ManifestEdit::ReplaceSegments { removed, added });
        self.normalize();
    }

    pub(crate) fn segment_paths(&self, dir: impl AsRef<Path>) -> Vec<PathBuf> {
        let dir = dir.as_ref();
        self.segments_newest_first
            .iter()
            .map(|filename| dir.join(filename))
            .collect()
    }

    pub(crate) fn segments_with_metadata_newest_first(
        &self,
        dir: impl AsRef<Path>,
    ) -> Vec<(PathBuf, Option<&SegmentMetadata>)> {
        let dir = dir.as_ref();
        self.segments_newest_first
            .iter()
            .map(|filename| {
                let metadata = self
                    .levels
                    .iter()
                    .flatten()
                    .find(|segment| segment.filename == *filename);
                (dir.join(filename), metadata)
            })
            .collect()
    }

    fn replay_edit_log(&mut self, dir: &Path) -> io::Result<()> {
        let path = dir.join(MANIFEST_EDIT_LOG_FILE);
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for line in io::BufReader::new(file).lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let edit: ManifestEdit = serde_json::from_str(&line).map_err(invalid_data)?;
            self.apply_edit(edit);
        }
        Ok(())
    }

    fn apply_edit(&mut self, edit: ManifestEdit) {
        match edit {
            ManifestEdit::AddSegment(metadata) => {
                self.remove_segment_references(std::slice::from_ref(&metadata.filename));
                self.ensure_level(metadata.level as usize);
                self.segments_newest_first
                    .insert(0, metadata.filename.clone());
                let level = metadata.level as usize;
                if level == 0 {
                    self.levels[0].insert(0, metadata);
                } else {
                    self.levels[level].push(metadata);
                }
            }
            ManifestEdit::ReplaceSegments { removed, added } => {
                self.remove_segment_references(&removed);
                for metadata in added {
                    self.ensure_level(metadata.level as usize);
                    self.segments_newest_first
                        .insert(0, metadata.filename.clone());
                    let level = metadata.level as usize;
                    if level == 0 {
                        self.levels[0].insert(0, metadata);
                    } else {
                        self.levels[level].push(metadata);
                    }
                }
            }
        }
    }

    fn remove_segment_references(&mut self, removed: &[String]) {
        self.segments_newest_first
            .retain(|filename| !removed.contains(filename));
        for level in &mut self.levels {
            level.retain(|segment| !removed.contains(&segment.filename));
        }
    }

    fn ensure_level(&mut self, level: usize) {
        while self.levels.len() <= level {
            self.levels.push(Vec::new());
        }
    }

    fn normalize(&mut self) {
        if self.levels.is_empty() {
            self.levels.push(Vec::new());
        }
        if self.levels.iter().all(Vec::is_empty) && !self.segments_newest_first.is_empty() {
            self.levels[0] = self
                .segments_newest_first
                .iter()
                .cloned()
                .map(SegmentMetadata::level_zero)
                .collect();
        }
        let next_from_segments = self
            .segments_newest_first
            .iter()
            .filter_map(|filename| filename.strip_suffix(".sst"))
            .filter_map(|number| number.parse::<u64>().ok())
            .max()
            .map(|number| number + 1)
            .unwrap_or(1);
        self.next_file_number = self.next_file_number.max(next_from_segments);
    }
}

impl SegmentMetadata {
    pub(crate) fn level_zero(filename: String) -> Self {
        Self {
            filename,
            level: 0,
            smallest_key: None,
            largest_key: None,
            file_size_bytes: None,
        }
    }
}

fn append_edit_log(dir: &Path, edit: &ManifestEdit) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(MANIFEST_EDIT_LOG_FILE);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    serde_json::to_writer(&mut file, edit).map_err(invalid_data)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(())
}

fn clear_edit_log(dir: &Path) -> io::Result<()> {
    let path = dir.join(MANIFEST_EDIT_LOG_FILE);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn invalid_data(error: impl std::error::Error + Send + Sync + 'static) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{Manifest, ManifestEdit, SegmentMetadata, append_edit_log};

    #[test]
    fn manifest_allocates_padded_segment_names_and_roundtrips() {
        let tempdir = tempdir().expect("tempdir");
        let mut manifest = Manifest::default();
        let first = manifest.allocate_segment();
        let second = manifest.allocate_segment();
        assert_eq!(first, "00000000000000000001.sst");
        assert_eq!(second, "00000000000000000002.sst");
        manifest.add_newest_segment(first.clone());
        manifest.add_newest_segment(second.clone());
        manifest.save(tempdir.path()).expect("save");

        let loaded = Manifest::load(tempdir.path()).expect("load");
        assert_eq!(loaded.next_file_number, 3);
        assert_eq!(
            loaded.segments_newest_first,
            vec![second.clone(), first.clone()]
        );
        assert_eq!(loaded.levels[0][0].filename, second);
        assert_eq!(loaded.levels[0][1].filename, first);
        assert_eq!(loaded.segment_paths(tempdir.path()).len(), 2);
    }

    #[test]
    fn manifest_persists_and_replays_edit_log_entries() {
        let tempdir = tempdir().expect("tempdir");
        append_edit_log(
            tempdir.path(),
            &ManifestEdit::AddSegment(SegmentMetadata::level_zero(
                "00000000000000000007.sst".to_string(),
            )),
        )
        .expect("append edit");

        let loaded = Manifest::load(tempdir.path()).expect("load");
        assert_eq!(
            loaded.segments_newest_first,
            vec!["00000000000000000007.sst"]
        );
        assert_eq!(loaded.levels[0][0].filename, "00000000000000000007.sst");
        assert_eq!(loaded.next_file_number, 8);
    }

    #[test]
    fn manifest_persist_edit_snapshots_and_clears_log() {
        let tempdir = tempdir().expect("tempdir");
        let mut manifest = Manifest::default();
        manifest
            .persist_edit(
                tempdir.path(),
                ManifestEdit::AddSegment(SegmentMetadata::level_zero(
                    "00000000000000000002.sst".to_string(),
                )),
            )
            .expect("persist edit");

        assert!(!tempdir.path().join("MANIFEST.log").exists());
        let loaded = Manifest::load(tempdir.path()).expect("load");
        assert_eq!(
            loaded.segments_newest_first,
            vec!["00000000000000000002.sst"]
        );
    }

    #[test]
    fn manifest_replace_segments_updates_flat_and_level_views() {
        let mut manifest = Manifest::default();
        manifest.add_newest_segment("one.sst".to_string());
        manifest.add_newest_segment("two.sst".to_string());
        manifest.replace_segments(
            vec!["one.sst".to_string(), "two.sst".to_string()],
            vec![SegmentMetadata::level_zero("merged.sst".to_string())],
        );

        assert_eq!(manifest.segments_newest_first, vec!["merged.sst"]);
        assert_eq!(manifest.levels[0].len(), 1);
        assert_eq!(manifest.levels[0][0].filename, "merged.sst");
    }

    #[test]
    fn missing_manifest_loads_default() {
        let tempdir = tempdir().expect("tempdir");
        assert_eq!(
            Manifest::load(tempdir.path()).expect("load"),
            Manifest::default()
        );
    }
}
