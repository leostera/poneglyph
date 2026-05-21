mod common;

use std::sync::Arc;

use common::{
    assert_entity_pipeline_deletes_retracted_entity,
    assert_entity_pipeline_materializes_latest_values,
};
use poneglyph::{EntityStore, FactService, Value, uri};
use poneglyph_local::{SqliteEntityStore, SqliteFactStore};
use tempfile::TempDir;

async fn make_services() -> (TempDir, TempDir, FactService, Arc<dyn EntityStore>) {
    let facts_dir = tempfile::tempdir().expect("facts tempdir");
    let entities_dir = tempfile::tempdir().expect("entities tempdir");
    let fact_store = Arc::new(
        SqliteFactStore::open(facts_dir.path())
            .await
            .expect("fact store"),
    );
    let entity_store: Arc<dyn EntityStore> = Arc::new(
        SqliteEntityStore::open(entities_dir.path())
            .await
            .expect("entity store"),
    );
    let fact_service = FactService::builder()
        .with_store_arc(fact_store.clone())
        .build()
        .expect("fact service");
    let _ = fact_store;
    (facts_dir, entities_dir, fact_service, entity_store)
}

#[tokio::test]
async fn sqlite_entity_service_materializes_latest_values_from_fact_broadcasts() {
    let (_facts_dir, _entities_dir, fact_service, entity_store) = make_services().await;

    assert_entity_pipeline_materializes_latest_values(
        &fact_service,
        entity_store,
        &uri!("spotify:album:counterparts"),
        vec![
            (uri!("spotify:displayName"), Value::text("Counterparts")),
            (uri!("spotify:releaseYear"), Value::integer(1993)),
        ],
    )
    .await;
}

#[tokio::test]
async fn sqlite_entity_service_deletes_entities_when_the_last_field_is_retracted() {
    let (_facts_dir, _entities_dir, fact_service, entity_store) = make_services().await;

    assert_entity_pipeline_deletes_retracted_entity(
        &fact_service,
        entity_store,
        &uri!("spotify:album:test-for-echo"),
        &uri!("spotify:displayName"),
        Value::text("Test for Echo"),
    )
    .await;
}
