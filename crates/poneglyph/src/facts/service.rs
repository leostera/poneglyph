use std::sync::Arc;

use derive_builder::Builder;
use tokio::sync::{broadcast, mpsc};

use crate::facts::store::Store;
use crate::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, Uri};

const DEFAULT_BROADCAST_BUFFER: usize = 1024;

#[derive(Clone, Builder)]
#[builder(pattern = "owned", build_fn(private, name = "fallible_build"))]
pub struct FactService {
    store: Arc<dyn Store>,
    #[builder(setter(skip), default = "new_broadcaster()")]
    broadcaster: broadcast::Sender<Fact>,
}

impl FactService {
    pub fn builder() -> FactServiceBuilder {
        FactServiceBuilder::default()
    }

    pub async fn state_facts(&self, facts: mpsc::Receiver<Fact>) -> PoneResult<Uri> {
        let (tx_id, committed_facts) = self.store.state_facts(facts).await?;
        for fact in committed_facts {
            let _ = self.broadcaster.send(fact);
        }
        Ok(tx_id)
    }

    pub async fn get_facts(&self, filter: Filter) -> PoneResult<mpsc::Receiver<PoneResult<Fact>>> {
        self.store.get_facts(filter).await
    }

    pub async fn get_active_facts(
        &self,
        filter: ActiveFilter,
    ) -> PoneResult<mpsc::Receiver<PoneResult<ActiveFact>>> {
        self.store.get_active_facts(filter).await
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Fact> {
        self.broadcaster.subscribe()
    }

    pub fn store(&self) -> Arc<dyn Store> {
        self.store.clone()
    }
}

impl FactServiceBuilder {
    pub fn with_store<S>(self, store: S) -> Self
    where
        S: Store + 'static,
    {
        self.store(Arc::new(store))
    }

    pub fn with_store_arc(self, store: Arc<dyn Store>) -> Self {
        self.store(store)
    }

    pub fn build(self) -> PoneResult<FactService> {
        self.fallible_build()
            .map_err(|_| Error::MissingFactServiceStore)
    }
}

fn new_broadcaster() -> broadcast::Sender<Fact> {
    broadcast::channel(DEFAULT_BROADCAST_BUFFER).0
}
