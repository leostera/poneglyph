use async_trait::async_trait;
use std::sync::Mutex;
use tokio::sync::mpsc;

use crate::active_graph::ActiveGraph;
use crate::facts::store::{
    Store, current_fact_state, new_tx_id, sort_facts, validate_pending_fact,
};
use crate::schema::SchemaSnapshot;
use crate::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, SchemaDefinition, Uri};

#[derive(Default)]
struct MemoryState {
    facts: Vec<Fact>,
    active_graph: ActiveGraph,
    schema: SchemaSnapshot,
}

#[derive(Default)]
pub struct InMemoryFactStore {
    state: Mutex<MemoryState>,
}

impl InMemoryFactStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl Store for InMemoryFactStore {
    async fn state_facts(
        &self,
        mut fact_stream: mpsc::Receiver<Fact>,
    ) -> PoneResult<(Uri, Vec<Fact>)> {
        let mut incoming = Vec::new();
        while let Some(fact) = fact_stream.recv().await {
            validate_pending_fact(&fact)?;
            incoming.push(fact);
        }
        if incoming.is_empty() {
            return Err(Error::EmptyFactBatch);
        }

        let tx_id = new_tx_id();
        let mut state = self.state.lock().expect("memory store lock");
        let mut persisted = Vec::new();

        for fact in incoming {
            let mut known = state.facts.clone();
            known.extend(persisted.iter().cloned());

            if fact.retraction {
                match current_fact_state(&known, &fact)? {
                    Some(active) if !active.retraction => {}
                    Some(_) => continue,
                    None => return Err(Error::CannotRetractUnknownFact),
                }
            }

            let mut persisted_fact = fact;
            persisted_fact.tx_id = Some(tx_id.clone());
            persisted.push(persisted_fact);
        }

        state.facts.extend(persisted.clone());
        sort_facts(&mut state.facts);
        state.active_graph.apply_facts(persisted.clone())?;
        for fact in &persisted {
            state.schema.apply_fact(fact);
        }

        Ok((tx_id, persisted))
    }

    async fn get_facts(&self, filter: Filter) -> PoneResult<mpsc::Receiver<PoneResult<Fact>>> {
        let mut facts = self.state.lock().expect("memory store lock").facts.clone();
        sort_facts(&mut facts);

        let filtered = match filter {
            Filter::All => facts,
            Filter::ById(fact_id) => facts
                .into_iter()
                .filter(|fact| fact.fact_id == fact_id)
                .collect::<Vec<_>>(),
            Filter::ByTx(tx_id) => facts
                .into_iter()
                .filter(|fact| fact.tx_id.as_ref() == Some(&tx_id))
                .collect::<Vec<_>>(),
            Filter::ByEntityUri(entity_uri) => facts
                .into_iter()
                .filter(|fact| fact.entity == entity_uri)
                .collect::<Vec<_>>(),
        };

        let (tx, rx) = mpsc::channel(filtered.len().max(1));
        tokio::spawn(async move {
            for fact in filtered {
                if tx.send(Ok(fact)).await.is_err() {
                    break;
                }
            }
        });

        Ok(rx)
    }

    async fn get_active_facts(
        &self,
        filter: ActiveFilter,
    ) -> PoneResult<mpsc::Receiver<PoneResult<ActiveFact>>> {
        let active_facts = self
            .state
            .lock()
            .expect("memory store lock")
            .active_graph
            .active_facts_matching(&filter);

        let (tx, rx) = mpsc::channel(active_facts.len().max(1));
        tokio::spawn(async move {
            for fact in active_facts {
                if tx.send(Ok(fact)).await.is_err() {
                    break;
                }
            }
        });

        Ok(rx)
    }

    async fn get_schema(&self) -> PoneResult<SchemaDefinition> {
        Ok(self
            .state
            .lock()
            .expect("memory store lock")
            .schema
            .clone()
            .into_definition())
    }
}
