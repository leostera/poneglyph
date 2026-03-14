mod search;

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::{debug, info, instrument, warn};

use crate::{Entity, Error, PoneResult};

pub use search::{SearchHit, SearchProjection};

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionBatch {
    pub entities: Vec<Entity>,
}

#[async_trait]
pub trait Projection: Send + Sync {
    fn name(&self) -> &'static str;
    async fn handle_events(&self, batch: ProjectionBatch) -> PoneResult<()>;
}

pub struct ProjectionRunner {
    entity_subscription: broadcast::Receiver<Entity>,
    projections: Vec<Arc<dyn Projection>>,
}

impl ProjectionRunner {
    pub fn builder() -> ProjectionRunnerBuilder {
        ProjectionRunnerBuilder::default()
    }

    #[instrument(skip_all, fields(component = "projection_runner"))]
    pub async fn start(mut self) -> PoneResult<()> {
        info!(
            projection_count = self.projections.len(),
            "projection runner started"
        );
        loop {
            let entity = match self.entity_subscription.recv().await {
                Ok(entity) => entity,
                Err(broadcast::error::RecvError::Closed) => {
                    info!("entity subscription closed; stopping projection runner");
                    return Ok(());
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "projection runner lagged behind entity broadcast");
                    continue;
                }
            };

            let mut entities = vec![entity];
            while let Ok(entity) = self.entity_subscription.try_recv() {
                entities.push(entity);
            }
            let batch = ProjectionBatch { entities };
            debug!(
                entity_count = batch.entities.len(),
                "dispatching projection batch"
            );

            for projection in &self.projections {
                debug!(projection = projection.name(), "running projection");
                projection.handle_events(batch.clone()).await?;
            }
        }
    }

    pub fn spawn(self) -> JoinHandle<PoneResult<()>> {
        tokio::spawn(async move { self.start().await })
    }
}

#[derive(Default)]
pub struct ProjectionRunnerBuilder {
    entity_subscription: Option<broadcast::Receiver<Entity>>,
    projections: Vec<Arc<dyn Projection>>,
}

impl ProjectionRunnerBuilder {
    pub fn with_entity_subscription(
        self,
        entity_subscription: broadcast::Receiver<Entity>,
    ) -> Self {
        Self {
            entity_subscription: Some(entity_subscription),
            ..self
        }
    }

    pub fn add_projection<P>(mut self, projection: P) -> Self
    where
        P: Projection + 'static,
    {
        self.projections.push(Arc::new(projection));
        self
    }

    pub fn add_projection_arc(mut self, projection: Arc<dyn Projection>) -> Self {
        self.projections.push(projection);
        self
    }

    pub fn build(self) -> PoneResult<ProjectionRunner> {
        if self.projections.is_empty() {
            return Err(Error::MissingProjectionRunnerProjection);
        }

        Ok(ProjectionRunner {
            entity_subscription: self
                .entity_subscription
                .ok_or(Error::MissingProjectionRunnerEntitySubscription)?,
            projections: self.projections,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use tokio::task::yield_now;
    use tokio::time::timeout;

    use crate::{
        Consolidator, EntityStore, FactService, InMemoryEntityStore, InMemoryFactStore, PoneResult,
        Value, fact, uri,
    };

    use super::{Projection, ProjectionBatch, ProjectionRunner};

    #[derive(Default)]
    struct RecordingProjection {
        batches: Mutex<Vec<ProjectionBatch>>,
    }

    impl RecordingProjection {
        fn recorded(&self) -> Vec<ProjectionBatch> {
            self.batches.lock().expect("projection batches").clone()
        }
    }

    #[async_trait]
    impl Projection for RecordingProjection {
        fn name(&self) -> &'static str {
            "recording"
        }

        async fn handle_events(&self, batch: ProjectionBatch) -> PoneResult<()> {
            self.batches.lock().expect("projection batches").push(batch);
            Ok(())
        }
    }

    async fn wait_for_batches(
        projection: &RecordingProjection,
        expected_batches: usize,
    ) -> Vec<ProjectionBatch> {
        timeout(Duration::from_secs(1), async {
            loop {
                let batches = projection.recorded();
                if batches.len() >= expected_batches {
                    return batches;
                }
                yield_now().await;
            }
        })
        .await
        .expect("projection eventually records expected batches")
    }

    #[tokio::test]
    async fn projection_runner_fans_out_materialized_entity_batches_to_all_projections() {
        let fact_service = FactService::builder()
            .with_store(InMemoryFactStore::new())
            .build()
            .expect("fact service");
        let entity_store: Arc<dyn EntityStore> = Arc::new(InMemoryEntityStore::new());
        let consolidator = Consolidator::builder()
            .with_entity_store_arc(entity_store)
            .with_fact_subscription(fact_service.subscribe())
            .build()
            .expect("consolidator");
        let left = Arc::new(RecordingProjection::default());
        let right = Arc::new(RecordingProjection::default());
        let worker = ProjectionRunner::builder()
            .with_entity_subscription(consolidator.subscribe())
            .add_projection_arc(left.clone())
            .add_projection_arc(right.clone())
            .build()
            .expect("runner")
            .spawn();
        let consolidator_worker = consolidator.spawn();

        fact_service
            .state_facts(vec![
                fact!(
                    uri!("agent:codex:local"),
                    uri!("spotify:album:hemispheres"),
                    uri!("spotify:displayName"),
                    Value::text("Hemispheres")
                ),
                fact!(
                    uri!("agent:codex:local"),
                    uri!("spotify:album:hemispheres"),
                    uri!("spotify:releaseYear"),
                    Value::integer(1978)
                ),
            ])
            .await
            .expect("state_facts");

        let left_batches = wait_for_batches(left.as_ref(), 1).await;
        let right_batches = wait_for_batches(right.as_ref(), 1).await;

        assert_eq!(left_batches.len(), 1);
        assert_eq!(right_batches.len(), 1);
        assert_eq!(left_batches[0].entities.len(), 1);
        assert_eq!(right_batches[0].entities.len(), 1);
        assert_eq!(
            left_batches[0].entities[0].uri.as_str(),
            "spotify:album:hemispheres"
        );
        assert_eq!(
            right_batches[0].entities[0].uri.as_str(),
            "spotify:album:hemispheres"
        );

        worker.abort();
        consolidator_worker.abort();
    }

    #[tokio::test]
    async fn projection_runner_processes_multiple_entity_updates_as_multiple_batches() {
        let fact_service = FactService::builder()
            .with_store(InMemoryFactStore::new())
            .build()
            .expect("fact service");
        let entity_store: Arc<dyn EntityStore> = Arc::new(InMemoryEntityStore::new());
        let consolidator = Consolidator::builder()
            .with_entity_store_arc(entity_store)
            .with_fact_subscription(fact_service.subscribe())
            .build()
            .expect("consolidator");
        let projection = Arc::new(RecordingProjection::default());
        let worker = ProjectionRunner::builder()
            .with_entity_subscription(consolidator.subscribe())
            .add_projection_arc(projection.clone())
            .build()
            .expect("runner")
            .spawn();
        let consolidator_worker = consolidator.spawn();

        fact_service
            .state_facts(vec![fact!(
                uri!("agent:codex:local"),
                uri!("spotify:album:farewell-to-kings"),
                uri!("spotify:displayName"),
                Value::text("A Farewell to Kings")
            )])
            .await
            .expect("first");
        fact_service
            .state_facts(vec![fact!(
                uri!("agent:codex:local"),
                uri!("spotify:album:moving-pictures"),
                uri!("spotify:displayName"),
                Value::text("Moving Pictures")
            )])
            .await
            .expect("second");

        let batches = wait_for_batches(projection.as_ref(), 2).await;
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].entities.len(), 1);
        assert_eq!(batches[1].entities.len(), 1);

        worker.abort();
        consolidator_worker.abort();
    }
}
