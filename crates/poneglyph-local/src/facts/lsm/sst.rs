use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::memtable::{Memtable, MemtableEntry};

const TABLE_MAGIC: &[u8; 4] = b"PLS1";
const INDEX_MAGIC: &[u8; 4] = b"PLI1";
const FOOTER_MAGIC: &[u8; 4] = b"PLF1";
const KIND_VALUE: u8 = 1;
const KIND_TOMBSTONE: u8 = 2;
const INDEX_STRIDE: usize = 32;
const RECORD_HEADER_LEN: usize = 1 + 4 + 4;
const CHECKSUM_LEN: usize = 8;
const FOOTER_LEN: u64 = 8 + 4;

#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexEntry {
    first_key: Vec<u8>,
    offset: u64,
}

#[derive(Debug)]
pub(crate) struct SstReader {
    path: PathBuf,
    index: Vec<IndexEntry>,
    data_end: u64,
}

impl SstReader {
    pub(crate) fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let mut file = File::open(&path)?;
        let file_len = file.metadata()?.len();
        if file_len < 4 + FOOTER_LEN {
            return Err(io::Error::new(ErrorKind::InvalidData, "SST file too small"));
        }

        let mut table_magic = [0; 4];
        file.read_exact(&mut table_magic)?;
        if &table_magic != TABLE_MAGIC {
            return Err(io::Error::new(ErrorKind::InvalidData, "invalid SST magic"));
        }

        file.seek(SeekFrom::End(-(FOOTER_LEN as i64)))?;
        let mut index_offset_bytes = [0; 8];
        file.read_exact(&mut index_offset_bytes)?;
        let index_offset = u64::from_be_bytes(index_offset_bytes);
        let mut footer_magic = [0; 4];
        file.read_exact(&mut footer_magic)?;
        if &footer_magic != FOOTER_MAGIC {
            return Err(io::Error::new(ErrorKind::InvalidData, "invalid SST footer"));
        }
        if index_offset < 4 || index_offset > file_len - FOOTER_LEN {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "invalid SST index offset",
            ));
        }

        file.seek(SeekFrom::Start(index_offset))?;
        let index = read_index(&mut file)?;
        Ok(Self {
            path,
            index,
            data_end: index_offset,
        })
    }

    pub(crate) fn get(&self, key: &[u8]) -> io::Result<Option<MemtableEntry>> {
        let mut file = File::open(&self.path)?;
        let mut offset = self.seek_offset_for(key);
        file.seek(SeekFrom::Start(offset))?;
        while offset < self.data_end {
            let Some((next_offset, record_key, entry)) = read_record_at(&mut file, offset)? else {
                return Ok(None);
            };
            match record_key.as_slice().cmp(key) {
                std::cmp::Ordering::Equal => return Ok(Some(entry)),
                std::cmp::Ordering::Greater => return Ok(None),
                std::cmp::Ordering::Less => offset = next_offset,
            }
        }
        Ok(None)
    }

    pub(crate) fn scan_prefix(&self, prefix: &[u8]) -> io::Result<Vec<(Vec<u8>, MemtableEntry)>> {
        let mut file = File::open(&self.path)?;
        let mut offset = self.seek_offset_for(prefix);
        file.seek(SeekFrom::Start(offset))?;
        let mut rows = Vec::new();
        while offset < self.data_end {
            let Some((next_offset, key, entry)) = read_record_at(&mut file, offset)? else {
                break;
            };
            if key.starts_with(prefix) {
                rows.push((key, entry));
            } else if key.as_slice() > prefix && !rows.is_empty() {
                break;
            } else if key.as_slice() > prefix {
                break;
            }
            offset = next_offset;
        }
        Ok(rows)
    }

    fn seek_offset_for(&self, key: &[u8]) -> u64 {
        self.index
            .partition_point(|entry| entry.first_key.as_slice() <= key)
            .checked_sub(1)
            .and_then(|index| self.index.get(index))
            .map_or(4, |entry| entry.offset)
    }
}

pub(crate) fn write_memtable(path: impl AsRef<Path>, memtable: &Memtable) -> io::Result<SstReader> {
    write_entries(path.as_ref(), memtable.iter())
}

fn write_entries<'a>(
    path: &Path,
    entries: impl IntoIterator<Item = (&'a [u8], &'a MemtableEntry)>,
) -> io::Result<SstReader> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp_path = path.with_extension("sst.tmp");
    let mut file = File::create(&temp_path)?;
    file.write_all(TABLE_MAGIC)?;

    let mut index = Vec::new();
    let mut last_key: Option<Vec<u8>> = None;
    for (record_index, (key, entry)) in entries.into_iter().enumerate() {
        if let Some(last_key) = &last_key {
            if last_key.as_slice() >= key {
                return Err(io::Error::new(
                    ErrorKind::InvalidInput,
                    "SST entries must be strictly sorted by key",
                ));
            }
        }
        let offset = file.stream_position()?;
        if record_index % INDEX_STRIDE == 0 {
            index.push(IndexEntry {
                first_key: key.to_vec(),
                offset,
            });
        }
        write_record(&mut file, key, entry)?;
        last_key = Some(key.to_vec());
    }

    let index_offset = file.stream_position()?;
    write_index(&mut file, &index)?;
    file.write_all(&index_offset.to_be_bytes())?;
    file.write_all(FOOTER_MAGIC)?;
    file.sync_all()?;
    std::fs::rename(&temp_path, path)?;
    SstReader::open(path)
}

fn write_record(file: &mut File, key: &[u8], entry: &MemtableEntry) -> io::Result<()> {
    let (kind, value) = match entry {
        MemtableEntry::Value(value) => (KIND_VALUE, value.as_slice()),
        MemtableEntry::Tombstone => (KIND_TOMBSTONE, &[][..]),
    };
    let key_len = u32::try_from(key.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "SST key too large"))?;
    let value_len = u32::try_from(value.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "SST value too large"))?;
    let checksum = checksum(kind, key, value);

    file.write_all(&[kind])?;
    file.write_all(&key_len.to_be_bytes())?;
    file.write_all(&value_len.to_be_bytes())?;
    file.write_all(key)?;
    file.write_all(value)?;
    file.write_all(&checksum.to_be_bytes())?;
    Ok(())
}

fn read_record_at(
    file: &mut File,
    offset: u64,
) -> io::Result<Option<(u64, Vec<u8>, MemtableEntry)>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut header = [0; RECORD_HEADER_LEN];
    match file.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let kind = header[0];
    let key_len = u32::from_be_bytes(header[1..5].try_into().expect("key length")) as usize;
    let value_len = u32::from_be_bytes(header[5..9].try_into().expect("value length")) as usize;
    let mut key = vec![0; key_len];
    file.read_exact(&mut key)?;
    let mut value = vec![0; value_len];
    file.read_exact(&mut value)?;
    let mut checksum_bytes = [0; CHECKSUM_LEN];
    file.read_exact(&mut checksum_bytes)?;
    let expected = u64::from_be_bytes(checksum_bytes);
    let actual = checksum(kind, &key, &value);
    if expected != actual {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "invalid SST record checksum",
        ));
    }
    let entry = match kind {
        KIND_VALUE => MemtableEntry::Value(value),
        KIND_TOMBSTONE if value.is_empty() => MemtableEntry::Tombstone,
        KIND_TOMBSTONE => {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "SST tombstone carried a value",
            ));
        }
        _ => {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "invalid SST record kind",
            ));
        }
    };
    let next_offset = file.stream_position()?;
    Ok(Some((next_offset, key, entry)))
}

fn write_index(file: &mut File, index: &[IndexEntry]) -> io::Result<()> {
    file.write_all(INDEX_MAGIC)?;
    let len = u32::try_from(index.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "SST index too large"))?;
    file.write_all(&len.to_be_bytes())?;
    for entry in index {
        let key_len = u32::try_from(entry.first_key.len())
            .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "SST index key too large"))?;
        file.write_all(&key_len.to_be_bytes())?;
        file.write_all(&entry.first_key)?;
        file.write_all(&entry.offset.to_be_bytes())?;
    }
    Ok(())
}

fn read_index(file: &mut File) -> io::Result<Vec<IndexEntry>> {
    let mut magic = [0; 4];
    file.read_exact(&mut magic)?;
    if &magic != INDEX_MAGIC {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "invalid SST index magic",
        ));
    }
    let mut len_bytes = [0; 4];
    file.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    let mut index = Vec::with_capacity(len);
    for _ in 0..len {
        let mut key_len_bytes = [0; 4];
        file.read_exact(&mut key_len_bytes)?;
        let key_len = u32::from_be_bytes(key_len_bytes) as usize;
        let mut first_key = vec![0; key_len];
        file.read_exact(&mut first_key)?;
        let mut offset_bytes = [0; 8];
        file.read_exact(&mut offset_bytes)?;
        index.push(IndexEntry {
            first_key,
            offset: u64::from_be_bytes(offset_bytes),
        });
    }
    Ok(index)
}

fn checksum(kind: u8, key: &[u8], value: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    TABLE_MAGIC.hash(&mut hasher);
    kind.hash(&mut hasher);
    key.hash(&mut hasher);
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{SstReader, write_memtable};
    use crate::facts::lsm::memtable::{Memtable, MemtableEntry};

    #[test]
    fn sst_reads_points_and_prefixes() {
        let tempdir = tempdir().expect("tempdir");
        let path = tempdir.path().join("000001.sst");
        let mut memtable = Memtable::new();
        memtable.insert(b"active/field/a/1".to_vec(), b"one".to_vec());
        memtable.insert(b"active/field/a/2".to_vec(), b"two".to_vec());
        memtable.insert(b"active/field/b/1".to_vec(), b"three".to_vec());
        memtable.delete(b"active/field/a/3".to_vec());

        let reader = write_memtable(&path, &memtable).expect("write sst");
        assert_eq!(
            reader.get(b"active/field/a/1").expect("get"),
            Some(MemtableEntry::Value(b"one".to_vec()))
        );
        assert_eq!(
            reader.get(b"active/field/a/3").expect("get"),
            Some(MemtableEntry::Tombstone)
        );
        assert_eq!(reader.get(b"missing").expect("get"), None);

        let rows = reader
            .scan_prefix(b"active/field/a/")
            .expect("prefix scan")
            .into_iter()
            .map(|(key, _)| key)
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![
                b"active/field/a/1".to_vec(),
                b"active/field/a/2".to_vec(),
                b"active/field/a/3".to_vec(),
            ]
        );
    }

    #[test]
    fn sst_reopens_index_from_disk() {
        let tempdir = tempdir().expect("tempdir");
        let path = tempdir.path().join("000001.sst");
        let mut memtable = Memtable::new();
        for index in 0..100 {
            memtable.insert(format!("key/{index:03}").into_bytes(), vec![index as u8]);
        }
        write_memtable(&path, &memtable).expect("write sst");

        let reader = SstReader::open(&path).expect("open sst");
        assert_eq!(
            reader.get(b"key/099").expect("get"),
            Some(MemtableEntry::Value(vec![99]))
        );
        assert_eq!(reader.scan_prefix(b"key/09").expect("scan").len(), 10);
    }
}
