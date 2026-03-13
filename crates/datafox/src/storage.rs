use std::collections::BTreeMap;

use crate::{Result, Value};

pub type FactTuple = Vec<Value>;
pub type TupleStream<'a> = Box<dyn Iterator<Item = Result<FactTuple>> + 'a>;

/// Snapshot-oriented read-only storage interface for Datalog queries.
pub trait Storage {
    fn get_facts_matching<'a>(
        &'a self,
        predicate: &str,
        pattern: Vec<Option<Value>>,
    ) -> Result<TupleStream<'a>>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InMemoryStorage {
    facts: BTreeMap<String, Vec<FactTuple>>,
}

impl InMemoryStorage {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_facts(facts: impl IntoIterator<Item = (String, Vec<FactTuple>)>) -> Self {
        Self {
            facts: facts.into_iter().collect(),
        }
    }

    pub fn insert(&mut self, predicate: impl Into<String>, tuple: FactTuple) {
        self.facts.entry(predicate.into()).or_default().push(tuple);
    }
}

impl Storage for InMemoryStorage {
    fn get_facts_matching<'a>(
        &'a self,
        predicate: &str,
        pattern: Vec<Option<Value>>,
    ) -> Result<TupleStream<'a>> {
        let tuples = self
            .facts
            .get(predicate)
            .into_iter()
            .flatten()
            .filter(move |tuple| matches_pattern(&pattern, tuple))
            .cloned()
            .map(Ok);

        Ok(Box::new(tuples))
    }
}

pub fn matches_pattern(pattern: &[Option<Value>], tuple: &[Value]) -> bool {
    pattern.len() == tuple.len()
        && pattern
            .iter()
            .zip(tuple)
            .all(|(pattern, value)| match pattern {
                Some(pattern) => pattern == value,
                None => true,
            })
}

#[cfg(test)]
mod tests {
    use crate::{InMemoryStorage, Storage, Value, matches_pattern};

    #[test]
    fn matches_pattern_treats_none_as_wildcard() {
        assert!(matches_pattern(
            &[Some(Value::integer(1)), None],
            &[Value::integer(1), Value::integer(2)],
        ));
        assert!(!matches_pattern(
            &[Some(Value::integer(1)), None],
            &[Value::integer(2), Value::integer(3)],
        ));
    }

    #[test]
    fn in_memory_storage_filters_matching_tuples() {
        let storage = InMemoryStorage::from_facts([(
            "edge".to_string(),
            vec![
                vec![Value::integer(1), Value::integer(2)],
                vec![Value::integer(2), Value::integer(3)],
            ],
        )]);

        let tuples = storage
            .get_facts_matching("edge", vec![Some(Value::integer(1)), None])
            .expect("tuples")
            .collect::<Result<Vec<_>, _>>()
            .expect("tuple results");

        assert_eq!(tuples, vec![vec![Value::integer(1), Value::integer(2)]]);
    }
}
