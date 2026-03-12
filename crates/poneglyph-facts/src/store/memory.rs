use anyhow::{Result, anyhow};
use async_trait::async_trait;
use poneglyph_core::{Fact, Filter, Uri};
use std::sync::Mutex;
use tokio::sync::mpsc;

use super::{
    FactReceiver, Store, current_fact_state, new_tx_id, sort_visible_facts, validate_pending_fact,
};

#[derive(Default)]
struct MemoryState {
    facts: Vec<Fact>,
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
    async fn state_facts(&self, mut fact_stream: mpsc::Receiver<Fact>) -> Result<Uri> {
        let mut incoming = Vec::new();
        while let Some(fact) = fact_stream.recv().await {
            validate_pending_fact(&fact)?;
            incoming.push(fact);
        }
        if incoming.is_empty() {
            return Err(anyhow!("state_facts requires at least one fact"));
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
                    None => return Err(anyhow!("cannot retract unknown fact")),
                }
            }

            let mut persisted_fact = fact;
            persisted_fact.tx_id = Some(tx_id.clone());
            persisted.push(persisted_fact);
        }

        state.facts.extend(persisted);
        sort_visible_facts(&mut state.facts);

        Ok(tx_id)
    }

    async fn get_facts(&self, filter: Filter) -> Result<FactReceiver> {
        let mut facts = self.state.lock().expect("memory store lock").facts.clone();
        sort_visible_facts(&mut facts);

        let filtered = match filter {
            Filter::ById(fact_id) => facts
                .into_iter()
                .filter(|fact| fact.fact_id == fact_id)
                .collect::<Vec<_>>(),
            Filter::ByTx(tx_id) => facts
                .into_iter()
                .filter(|fact| fact.tx_id.as_ref() == Some(&tx_id))
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
}
