use std::collections::BTreeMap;
use std::ops::Bound;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MemtableEntry {
    Value(Vec<u8>),
    Tombstone,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct Memtable {
    entries: BTreeMap<Vec<u8>, MemtableEntry>,
    approximate_size: usize,
}

impl Memtable {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn insert(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.adjust_size_for_replace(&key, &MemtableEntry::Value(value.clone()));
        self.entries.insert(key, MemtableEntry::Value(value));
    }

    pub(crate) fn delete(&mut self, key: Vec<u8>) {
        self.adjust_size_for_replace(&key, &MemtableEntry::Tombstone);
        self.entries.insert(key, MemtableEntry::Tombstone);
    }

    pub(crate) fn get(&self, key: &[u8]) -> Option<&MemtableEntry> {
        self.entries.get(key)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&[u8], &MemtableEntry)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_slice(), value))
    }

    pub(crate) fn scan_prefix<'a>(
        &'a self,
        prefix: &'a [u8],
    ) -> impl Iterator<Item = (&'a [u8], &'a MemtableEntry)> + 'a {
        let start = Bound::Included(prefix.to_vec());
        self.entries
            .range((start, Bound::Unbounded))
            .take_while(move |(key, _)| key.starts_with(prefix))
            .map(|(key, value)| (key.as_slice(), value))
    }

    pub(crate) fn approximate_size(&self) -> usize {
        self.approximate_size
    }

    fn adjust_size_for_replace(&mut self, key: &[u8], next: &MemtableEntry) {
        if let Some(previous) = self.entries.get(key) {
            self.approximate_size = self
                .approximate_size
                .saturating_sub(entry_size(key, previous));
        }
        self.approximate_size += entry_size(key, next);
    }
}

fn entry_size(key: &[u8], entry: &MemtableEntry) -> usize {
    key.len()
        + match entry {
            MemtableEntry::Value(value) => value.len(),
            MemtableEntry::Tombstone => 0,
        }
}

#[cfg(test)]
mod tests {
    use super::{Memtable, MemtableEntry};

    #[test]
    fn memtable_gets_latest_value_or_tombstone() {
        let mut memtable = Memtable::new();
        memtable.insert(b"key".to_vec(), b"one".to_vec());
        assert_eq!(
            memtable.get(b"key"),
            Some(&MemtableEntry::Value(b"one".to_vec()))
        );

        memtable.insert(b"key".to_vec(), b"two".to_vec());
        assert_eq!(
            memtable.get(b"key"),
            Some(&MemtableEntry::Value(b"two".to_vec()))
        );

        memtable.delete(b"key".to_vec());
        assert_eq!(memtable.get(b"key"), Some(&MemtableEntry::Tombstone));
    }

    #[test]
    fn memtable_scans_prefix_in_key_order() {
        let mut memtable = Memtable::new();
        memtable.insert(b"aa/2".to_vec(), b"two".to_vec());
        memtable.insert(b"ab/1".to_vec(), b"skip".to_vec());
        memtable.insert(b"aa/1".to_vec(), b"one".to_vec());

        let keys = memtable
            .scan_prefix(b"aa/")
            .map(|(key, _)| key.to_vec())
            .collect::<Vec<_>>();
        assert_eq!(keys, vec![b"aa/1".to_vec(), b"aa/2".to_vec()]);
    }
}
