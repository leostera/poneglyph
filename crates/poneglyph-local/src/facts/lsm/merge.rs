use std::collections::BTreeSet;
use std::io;

use super::memtable::{Memtable, MemtableEntry};
use super::sst::SstReader;

pub(crate) fn get_merged(
    memtable: &Memtable,
    segments_newest_first: &[SstReader],
    key: &[u8],
) -> io::Result<Option<Vec<u8>>> {
    if let Some(entry) = memtable.get(key) {
        return Ok(entry.value().map(ToOwned::to_owned));
    }

    for segment in segments_newest_first {
        if !segment.may_contain_key(key) {
            continue;
        }
        if let Some(entry) = segment.get(key)? {
            return Ok(entry.value().map(ToOwned::to_owned));
        }
    }

    Ok(None)
}

pub(crate) fn scan_prefix_merged(
    memtable: &Memtable,
    segments_newest_first: &[SstReader],
    prefix: &[u8],
) -> io::Result<Vec<(Vec<u8>, Vec<u8>)>> {
    Ok(
        scan_prefix_entries_merged(memtable, segments_newest_first, prefix)?
            .into_iter()
            .filter_map(|(key, entry)| entry.value().map(|value| (key, value.to_vec())))
            .collect(),
    )
}

pub(crate) fn scan_prefix_entries_merged(
    memtable: &Memtable,
    segments_newest_first: &[SstReader],
    prefix: &[u8],
) -> io::Result<Vec<(Vec<u8>, MemtableEntry)>> {
    if segments_newest_first.is_empty() {
        return Ok(memtable
            .scan_prefix(prefix)
            .map(|(key, entry)| (key.to_vec(), entry.clone()))
            .collect());
    }

    let mut seen = BTreeSet::new();
    let mut rows = Vec::new();

    for (key, entry) in memtable.scan_prefix(prefix) {
        seen.insert(key.to_vec());
        rows.push((key.to_vec(), entry.clone()));
    }

    for segment in segments_newest_first {
        if !segment.may_contain_prefix(prefix) {
            continue;
        }
        for (key, entry) in segment.scan_prefix(prefix)? {
            if seen.insert(key.clone()) {
                rows.push((key, entry));
            }
        }
    }

    rows.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(rows)
}

impl MemtableEntry {
    fn value(&self) -> Option<&[u8]> {
        match self {
            Self::Value(value) => Some(value),
            Self::Tombstone => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{get_merged, scan_prefix_merged};
    use crate::facts::lsm::memtable::Memtable;
    use crate::facts::lsm::sst::write_memtable;

    #[test]
    fn merged_get_prefers_memtable_then_newer_segments() {
        let tempdir = tempdir().expect("tempdir");

        let mut older = Memtable::new();
        older.insert(b"k".to_vec(), b"old".to_vec());
        let older = write_memtable(tempdir.path().join("older.sst"), &older).expect("older");

        let mut newer = Memtable::new();
        newer.insert(b"k".to_vec(), b"new".to_vec());
        let newer = write_memtable(tempdir.path().join("newer.sst"), &newer).expect("newer");

        let empty = Memtable::new();
        assert_eq!(
            get_merged(&empty, &[newer.clone(), older], b"k").expect("get"),
            Some(b"new".to_vec())
        );

        let mut memtable = Memtable::new();
        memtable.delete(b"k".to_vec());
        assert_eq!(get_merged(&memtable, &[newer], b"k").expect("get"), None);
    }

    #[test]
    fn merged_prefix_scan_deduplicates_and_sorts_visible_values() {
        let tempdir = tempdir().expect("tempdir");

        let mut older = Memtable::new();
        older.insert(b"p/a".to_vec(), b"old-a".to_vec());
        older.insert(b"p/b".to_vec(), b"old-b".to_vec());
        older.insert(b"p/c".to_vec(), b"old-c".to_vec());
        let older = write_memtable(tempdir.path().join("older.sst"), &older).expect("older");

        let mut newer = Memtable::new();
        newer.insert(b"p/b".to_vec(), b"new-b".to_vec());
        newer.delete(b"p/c".to_vec());
        newer.insert(b"p/d".to_vec(), b"new-d".to_vec());
        let newer = write_memtable(tempdir.path().join("newer.sst"), &newer).expect("newer");

        let mut memtable = Memtable::new();
        memtable.insert(b"p/e".to_vec(), b"mem-e".to_vec());
        memtable.delete(b"p/a".to_vec());

        let rows = scan_prefix_merged(&memtable, &[newer, older], b"p/").expect("scan");
        assert_eq!(
            rows,
            vec![
                (b"p/b".to_vec(), b"new-b".to_vec()),
                (b"p/d".to_vec(), b"new-d".to_vec()),
                (b"p/e".to_vec(), b"mem-e".to_vec()),
            ]
        );
    }
}
