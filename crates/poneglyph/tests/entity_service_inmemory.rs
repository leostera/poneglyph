use std::sync::Arc;

mod common;

use common::{
    assert_entity_pipeline_deletes_retracted_entity,
    assert_entity_pipeline_materializes_latest_values,
};
use poneglyph::{EntityStore, FactService, InMemoryEntityStore, InMemoryFactStore, Value, uri};

#[tokio::test]
async fn inmemory_entity_service_materializes_latest_values_from_fact_broadcasts() {
    let fact_store = Arc::new(InMemoryFactStore::new());
    let fact_service = FactService::builder()
        .with_store_arc(fact_store.clone())
        .build()
        .expect("fact service");
    let entity_store: Arc<dyn EntityStore> = Arc::new(InMemoryEntityStore::new());

    assert_entity_pipeline_materializes_latest_values(
        &fact_service,
        entity_store,
        &uri!("spotify:album:permanent-waves"),
        vec![
            (uri!("spotify:displayName"), Value::text("Permanent Waves")),
            (uri!("spotify:releaseYear"), Value::integer(1980)),
        ],
    )
    .await;
}

#[tokio::test]
async fn inmemory_entity_service_deletes_entities_when_the_last_field_is_retracted() {
    let fact_store = Arc::new(InMemoryFactStore::new());
    let fact_service = FactService::builder()
        .with_store_arc(fact_store.clone())
        .build()
        .expect("fact service");
    let entity_store: Arc<dyn EntityStore> = Arc::new(InMemoryEntityStore::new());

    assert_entity_pipeline_deletes_retracted_entity(
        &fact_service,
        entity_store,
        &uri!("spotify:album:hold-your-fire"),
        &uri!("spotify:displayName"),
        Value::text("Hold Your Fire"),
    )
    .await;
}
