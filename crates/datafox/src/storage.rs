use std::collections::BTreeMap;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::{Result, Value};

pub type FactTuple = Vec<Value>;
pub type TupleStream = mpsc::Receiver<Result<FactTuple>>;

const DEFAULT_STREAM_BUFFER: usize = 64;

/// Snapshot-oriented read-only storage interface for Datalog queries.
#[async_trait]
pub trait Storage {
    async fn get_facts_matching(
        &self,
        predicate: &str,
        pattern: Vec<Option<Value>>,
    ) -> Result<TupleStream>;
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

#[async_trait]
impl Storage for InMemoryStorage {
    async fn get_facts_matching(
        &self,
        predicate: &str,
        pattern: Vec<Option<Value>>,
    ) -> Result<TupleStream> {
        let tuples = self
            .facts
            .get(predicate)
            .into_iter()
            .flatten()
            .filter(move |tuple| matches_pattern(&pattern, tuple))
            .cloned()
            .map(Ok)
            .collect::<Vec<_>>();

        let (tx, rx) = mpsc::channel(tuples.len().max(DEFAULT_STREAM_BUFFER));
        tokio::spawn(async move {
            for tuple in tuples {
                if tx.send(tuple).await.is_err() {
                    break;
                }
            }
        });

        Ok(rx)
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
    use tokio::runtime::Runtime;

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

        let runtime = Runtime::new().expect("runtime");
        let tuples = runtime.block_on(async {
            let mut tuples = storage
                .get_facts_matching("edge", vec![Some(Value::integer(1)), None])
                .await
                .expect("tuples");
            let mut results = Vec::new();
            while let Some(tuple) = tuples.recv().await {
                results.push(tuple.expect("tuple result"));
            }
            results
        });

        assert_eq!(tuples, vec![vec![Value::integer(1), Value::integer(2)]]);
    }
}
