use crate::{Result, Storage, TupleStream, Value};

/// A read-only query snapshot over a storage backend.
#[derive(Debug, Clone)]
pub struct Universe<S> {
    storage: S,
}

impl<S> Universe<S> {
    pub fn new(storage: S) -> Self {
        Self { storage }
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }
}

impl<S: Storage> Universe<S> {
    pub fn get_facts_matching<'a>(
        &'a self,
        predicate: &str,
        pattern: Vec<Option<Value>>,
    ) -> Result<TupleStream<'a>> {
        self.storage.get_facts_matching(predicate, pattern)
    }
}

#[cfg(test)]
mod tests {
    use crate::{InMemoryStorage, Universe, Value};

    #[test]
    fn universe_delegates_matching_reads_to_storage() {
        let universe = Universe::new(InMemoryStorage::from_facts([(
            "edge".to_string(),
            vec![vec![Value::integer(1), Value::integer(2)]],
        )]));

        let tuples = universe
            .get_facts_matching("edge", vec![Some(Value::integer(1)), None])
            .expect("tuples")
            .collect::<Result<Vec<_>, _>>()
            .expect("tuple results");

        assert_eq!(tuples, vec![vec![Value::integer(1), Value::integer(2)]]);
    }
}
