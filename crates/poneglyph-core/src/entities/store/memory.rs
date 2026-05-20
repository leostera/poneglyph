use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::entities::store::EntityStore;
use crate::{Entity, PoneResult, Uri};

#[derive(Default)]
struct MemoryState {
    entities: BTreeMap<Uri, (Entity, Option<Uri>)>,
}

#[derive(Default)]
pub struct InMemoryEntityStore {
    state: Mutex<MemoryState>,
}

impl InMemoryEntityStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl EntityStore for InMemoryEntityStore {
    async fn put_entity(
        &self,
        entity: Entity,
        last_processed_tx_id: Option<Uri>,
    ) -> PoneResult<()> {
        let mut state = self.state.lock().expect("entity store lock");
        state
            .entities
            .insert(entity.uri.clone(), (entity, last_processed_tx_id));
        Ok(())
    }

    async fn delete_entity(&self, entity_uri: &Uri) -> PoneResult<()> {
        let mut state = self.state.lock().expect("entity store lock");
        state.entities.remove(entity_uri);
        Ok(())
    }

    async fn get_entity(&self, entity_uri: &Uri) -> PoneResult<Option<Entity>> {
        let state = self.state.lock().expect("entity store lock");
        Ok(state
            .entities
            .get(entity_uri)
            .map(|(entity, _)| entity.clone()))
    }

    async fn list_entities(&self, limit: usize, offset: usize) -> PoneResult<Vec<Entity>> {
        let state = self.state.lock().expect("entity store lock");
        Ok(state
            .entities
            .values()
            .map(|(entity, _)| entity.clone())
            .skip(offset)
            .take(limit)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::entities::store::{EntityStore, InMemoryEntityStore};
    use crate::{Entity, Value, uri};

    #[tokio::test]
    async fn inmemory_entity_store_put_get_delete_roundtrip() {
        let store = InMemoryEntityStore::new();
        let entity = Entity {
            uri: uri!("spotify:album:power-windows"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields: BTreeMap::from([(uri!("spotify:displayName"), Value::text("Power Windows"))]),
        };

        store
            .put_entity(entity.clone(), Some(uri!("poneglyph:tx:1")))
            .await
            .expect("put_entity");

        let stored = store
            .get_entity(&entity.uri)
            .await
            .expect("get_entity")
            .expect("entity");
        assert_eq!(stored, entity);

        store
            .delete_entity(&entity.uri)
            .await
            .expect("delete_entity");

        let deleted = store.get_entity(&entity.uri).await.expect("get_entity");
        assert_eq!(deleted, None);
    }
}
