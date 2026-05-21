use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MANIFEST_FILE: &str = "MANIFEST.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) next_file_number: u64,
    pub(crate) segments_newest_first: Vec<String>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            next_file_number: 1,
            segments_newest_first: Vec::new(),
        }
    }
}

impl Manifest {
    pub(crate) fn load(dir: impl AsRef<Path>) -> io::Result<Self> {
        let path = dir.as_ref().join(MANIFEST_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(invalid_data),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn save(&self, dir: impl AsRef<Path>) -> io::Result<()> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        let path = dir.join(MANIFEST_FILE);
        let temp_path = dir.join("MANIFEST.json.tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(invalid_data)?;
        std::fs::write(&temp_path, bytes)?;
        std::fs::rename(temp_path, path)?;
        Ok(())
    }

    pub(crate) fn allocate_segment(&mut self) -> String {
        let number = self.next_file_number;
        self.next_file_number += 1;
        format!("{number:020}.sst")
    }

    pub(crate) fn add_newest_segment(&mut self, filename: String) {
        self.segments_newest_first.insert(0, filename);
    }

    pub(crate) fn segment_paths(&self, dir: impl AsRef<Path>) -> Vec<PathBuf> {
        let dir = dir.as_ref();
        self.segments_newest_first
            .iter()
            .map(|filename| dir.join(filename))
            .collect()
    }
}

fn invalid_data(error: impl std::error::Error + Send + Sync + 'static) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::Manifest;

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
        assert_eq!(loaded.segments_newest_first, vec![second, first]);
        assert_eq!(loaded.segment_paths(tempdir.path()).len(), 2);
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
