use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use tracing::debug;

use crate::projections::{Projection, ProjectionBatch};
use crate::{Entity, PoneResult, Uri, Value};

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SearchHit {
    pub entity_uri: Uri,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct IndexedEntity {
    pub entity_uri: Uri,
    pub namespace: String,
    pub kind: String,
}

pub trait SearchIndex: Projection {
    fn search(&self, query: &str, limit: usize) -> PoneResult<Vec<SearchHit>>;
}

/// In-memory search projection for core tests and non-durable runtimes.
///
/// Durable/local full-text implementations live in backend crates such as
/// `poneglyph-local`.
#[derive(Default)]
pub struct InMemorySearchIndex {
    entities: Mutex<BTreeMap<Uri, Entity>>,
}

impl InMemorySearchIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list_entities(&self, limit: usize, offset: usize) -> Vec<IndexedEntity> {
        self.entities
            .lock()
            .expect("search index")
            .values()
            .skip(offset)
            .take(limit)
            .map(|entity| IndexedEntity {
                entity_uri: entity.uri.clone(),
                namespace: entity.namespace.clone(),
                kind: entity.kind.clone(),
            })
            .collect()
    }
}

#[async_trait]
impl Projection for InMemorySearchIndex {
    fn name(&self) -> &'static str {
        "in-memory-search"
    }

    async fn handle_events(&self, batch: ProjectionBatch) -> PoneResult<()> {
        let mut entities = self.entities.lock().expect("search index");
        for entity in batch.entities {
            if entity.fields.is_empty() {
                entities.remove(&entity.uri);
            } else {
                entities.insert(entity.uri.clone(), entity);
            }
        }
        Ok(())
    }
}

impl SearchIndex for InMemorySearchIndex {
    fn search(&self, query: &str, limit: usize) -> PoneResult<Vec<SearchHit>> {
        let needle = query.to_lowercase();
        let hits = self
            .entities
            .lock()
            .expect("search index")
            .values()
            .filter(|entity| flatten_entity_content(entity).contains(&needle))
            .take(limit)
            .map(|entity| SearchHit {
                entity_uri: entity.uri.clone(),
                score: 1.0,
            })
            .collect::<Vec<_>>();
        debug!(hit_count = hits.len(), "in-memory search query evaluated");
        Ok(hits)
    }
}

fn flatten_entity_content(entity: &Entity) -> String {
    let mut parts = vec![
        entity.uri.as_str().to_lowercase(),
        entity.namespace.to_lowercase(),
        entity.kind.to_lowercase(),
    ];

    for (field, value) in &entity.fields {
        parts.push(field.as_str().to_lowercase());
        flatten_value(value, &mut parts);
    }

    parts.join(" ")
}

fn flatten_value(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::Null => {}
        Value::Text(text) | Value::Number(text) => parts.push(text.to_lowercase()),
        Value::Boolean(value) => parts.push(value.to_string()),
        Value::Bytes(bytes) => parts.push(format!("{bytes:x?}")),
        Value::Reference(uri) => parts.push(uri.as_str().to_lowercase()),
        Value::Date(date) => parts.push(date.to_string()),
        Value::DateTime(date_time) => parts.push(date_time.to_rfc3339()),
        Value::List(values) => {
            for value in values {
                flatten_value(value, parts);
            }
        }
        Value::Map(values) => {
            for (key, value) in values {
                parts.push(key.to_lowercase());
                flatten_value(value, parts);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{InMemorySearchIndex, SearchIndex};
    use std::collections::BTreeMap;

    use crate::{Entity, Projection, ProjectionBatch, Value, uri};

    #[tokio::test]
    async fn in_memory_search_indexes_and_removes_entities() {
        let index = InMemorySearchIndex::new();
        let entity_uri = uri!("memory:item:first");
        let mut entity = Entity {
            uri: entity_uri.clone(),
            namespace: "memory".to_string(),
            kind: "item".to_string(),
            fields: BTreeMap::new(),
        };
        entity
            .fields
            .insert(uri!("memory:title"), Value::text("First note"));

        index
            .handle_events(ProjectionBatch {
                entities: vec![entity],
            })
            .await
            .expect("index entity");
        assert_eq!(index.search("first", 10).expect("search").len(), 1);

        index
            .handle_events(ProjectionBatch {
                entities: vec![Entity {
                    uri: entity_uri,
                    namespace: "memory".to_string(),
                    kind: "item".to_string(),
                    fields: BTreeMap::new(),
                }],
            })
            .await
            .expect("remove entity");
        assert!(index.search("first", 10).expect("search").is_empty());
    }
}
