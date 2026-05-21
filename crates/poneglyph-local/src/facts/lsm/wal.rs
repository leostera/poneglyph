use std::collections::hash_map::DefaultHasher;
use std::fs::{File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use super::memtable::{Memtable, MemtableEntry};

const MAGIC: &[u8; 4] = b"PLW1";
const KIND_VALUE: u8 = 1;
const KIND_TOMBSTONE: u8 = 2;
const HEADER_LEN: usize = 4 + 1 + 4 + 4;
const CHECKSUM_LEN: usize = 8;

#[derive(Debug)]
pub(crate) struct Wal {
    path: PathBuf,
    file: File,
}

impl Wal {
    pub(crate) fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&path)?;
        Ok(Self { path, file })
    }

    pub(crate) fn append_value(&mut self, key: &[u8], value: &[u8]) -> io::Result<()> {
        write_record(&mut self.file, KIND_VALUE, key, Some(value))
    }

    pub(crate) fn append_tombstone(&mut self, key: &[u8]) -> io::Result<()> {
        write_record(&mut self.file, KIND_TOMBSTONE, key, None)
    }

    pub(crate) fn sync(&mut self) -> io::Result<()> {
        self.file.sync_data()
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

pub(crate) fn replay(path: impl AsRef<Path>) -> io::Result<Memtable> {
    let path = path.as_ref();
    let mut memtable = Memtable::new();
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(memtable),
        Err(error) => return Err(error),
    };

    loop {
        match read_record(&mut file)? {
            Some((key, entry)) => match entry {
                MemtableEntry::Value(value) => memtable.insert(key, value),
                MemtableEntry::Tombstone => memtable.delete(key),
            },
            None => return Ok(memtable),
        }
    }
}

fn write_record(file: &mut File, kind: u8, key: &[u8], value: Option<&[u8]>) -> io::Result<()> {
    let key_len = u32::try_from(key.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "WAL key too large"))?;
    let value_len = u32::try_from(value.map_or(0, <[u8]>::len))
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "WAL value too large"))?;
    let checksum = checksum(kind, key, value.unwrap_or_default());

    file.write_all(MAGIC)?;
    file.write_all(&[kind])?;
    file.write_all(&key_len.to_be_bytes())?;
    file.write_all(&value_len.to_be_bytes())?;
    file.write_all(key)?;
    if let Some(value) = value {
        file.write_all(value)?;
    }
    file.write_all(&checksum.to_be_bytes())?;
    Ok(())
}

fn read_record(file: &mut File) -> io::Result<Option<(Vec<u8>, MemtableEntry)>> {
    let mut header = [0; HEADER_LEN];
    match file.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    if &header[..4] != MAGIC {
        return Err(io::Error::new(ErrorKind::InvalidData, "invalid WAL magic"));
    }
    let kind = header[4];
    let key_len = u32::from_be_bytes(header[5..9].try_into().expect("key len bytes")) as usize;
    let value_len = u32::from_be_bytes(header[9..13].try_into().expect("value len bytes")) as usize;

    let mut key = vec![0; key_len];
    if read_or_torn_tail(file, &mut key)? {
        return Ok(None);
    }
    let mut value = vec![0; value_len];
    if read_or_torn_tail(file, &mut value)? {
        return Ok(None);
    }
    let mut checksum_bytes = [0; CHECKSUM_LEN];
    if read_or_torn_tail(file, &mut checksum_bytes)? {
        return Ok(None);
    }

    let expected = u64::from_be_bytes(checksum_bytes);
    let actual = checksum(kind, &key, &value);
    if expected != actual {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "invalid WAL checksum",
        ));
    }

    let entry = match kind {
        KIND_VALUE => MemtableEntry::Value(value),
        KIND_TOMBSTONE if value.is_empty() => MemtableEntry::Tombstone,
        KIND_TOMBSTONE => {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "tombstone WAL record carried a value",
            ));
        }
        _ => {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "invalid WAL record kind",
            ));
        }
    };
    Ok(Some((key, entry)))
}

fn read_or_torn_tail(file: &mut File, buffer: &mut [u8]) -> io::Result<bool> {
    match file.read_exact(buffer) {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(true),
        Err(error) => Err(error),
    }
}

fn checksum(kind: u8, key: &[u8], value: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    MAGIC.hash(&mut hasher);
    kind.hash(&mut hasher);
    key.hash(&mut hasher);
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use std::fs::OpenOptions;
    use std::io::Write as _;

    use tempfile::tempdir;

    use super::{Wal, replay};
    use crate::facts::lsm::memtable::MemtableEntry;

    #[test]
    fn wal_replays_values_and_tombstones() {
        let tempdir = tempdir().expect("tempdir");
        let path = tempdir.path().join("facts.wal");
        let mut wal = Wal::open(&path).expect("open wal");
        wal.append_value(b"a", b"one").expect("append a");
        wal.append_value(b"b", b"two").expect("append b");
        wal.append_tombstone(b"a").expect("delete a");
        wal.sync().expect("sync");
        drop(wal);

        let memtable = replay(&path).expect("replay");
        assert_eq!(memtable.get(b"a"), Some(&MemtableEntry::Tombstone));
        assert_eq!(
            memtable.get(b"b"),
            Some(&MemtableEntry::Value(b"two".to_vec()))
        );
    }

    #[test]
    fn wal_replay_ignores_torn_tail() {
        let tempdir = tempdir().expect("tempdir");
        let path = tempdir.path().join("facts.wal");
        let mut wal = Wal::open(&path).expect("open wal");
        wal.append_value(b"a", b"one").expect("append a");
        wal.sync().expect("sync");
        drop(wal);

        let mut file = OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open raw");
        file.write_all(b"PLW1\x01\x00").expect("partial tail");
        drop(file);

        let memtable = replay(&path).expect("replay");
        assert_eq!(
            memtable.get(b"a"),
            Some(&MemtableEntry::Value(b"one".to_vec()))
        );
    }
}
