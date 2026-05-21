mod memory;

use async_trait::async_trait;

use crate::{Entity, PoneResult, Uri};

pub use memory::InMemoryEntityStore;

#[async_trait]
pub trait EntityStore: Send + Sync {
    async fn put_entity(&self, entity: Entity, last_processed_tx_id: Option<Uri>)
    -> PoneResult<()>;
    async fn delete_entity(&self, entity_uri: &Uri) -> PoneResult<()>;
    async fn get_entity(&self, entity_uri: &Uri) -> PoneResult<Option<Entity>>;
    async fn list_entities(&self, limit: usize, offset: usize) -> PoneResult<Vec<Entity>>;
}
