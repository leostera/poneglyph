use std::sync::Arc;

use derive_builder::Builder;
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, warn};

use crate::facts::store::Store;
use crate::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, SchemaDefinition, Uri};

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

    pub async fn state_facts(&self, facts: Vec<Fact>) -> PoneResult<Uri> {
        self.stream_facts(fact_stream(facts)).await
    }

    pub async fn stream_facts(&self, facts: mpsc::Receiver<Fact>) -> PoneResult<Uri> {
        let (tx_id, committed_facts) = self.store.state_facts(facts).await?;
        let fact_count = committed_facts.len();
        debug!(%tx_id, fact_count, "stored fact batch");
        for fact in committed_facts {
            if self.broadcaster.send(fact).is_err() {
                warn!("fact batch committed without active subscribers");
            }
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
        debug!(component = "fact_service", "new fact subscriber");
        self.broadcaster.subscribe()
    }

    pub fn store(&self) -> Arc<dyn Store> {
        self.store.clone()
    }

    pub async fn get_schema(&self) -> PoneResult<SchemaDefinition> {
        self.store.get_schema().await
    }
}

fn fact_stream(facts: Vec<Fact>) -> mpsc::Receiver<Fact> {
    let (tx, rx) = mpsc::channel(facts.len().max(1));
    tokio::spawn(async move {
        for fact in facts {
            if tx.send(fact).await.is_err() {
                break;
            }
        }
    });
    rx
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
