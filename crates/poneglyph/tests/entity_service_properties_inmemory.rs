mod common;

use std::sync::Arc;

use common::{assert_entity_pipeline_deletes_retracted_entity, wait_for_entity_fields};
use poneglyph::{
    Consolidator, EntityStore, FactService, InMemoryEntityStore, InMemoryFactStore, Value, fact,
    uri,
};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn inmemory_property_stated_entity_facts_eventually_materialize_latest_field_values_long(
        assertions in prop::collection::vec(("[a-z][a-z0-9]{0,12}", any::<Value>()), 1..12)
    ) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async move {
            let fact_store = Arc::new(InMemoryFactStore::new());
            let fact_service = FactService::builder()
                .with_store_arc(fact_store.clone())
                .build()
                .expect("fact service");
            let entity_store: Arc<dyn EntityStore> = Arc::new(InMemoryEntityStore::new());
            let worker = Consolidator::builder()
                .with_entity_store_arc(entity_store.clone())
                .with_fact_subscription(fact_service.subscribe())
                .build()
                .expect("consolidator")
                .spawn();

            let entity_uri = uri!("spotify:album:property-inmemory");
            let mut expected = std::collections::BTreeMap::new();

            for (field_suffix, value) in assertions {
                let field_uri = uri!("spotify", "field", &field_suffix);
                expected.insert(field_uri.clone(), value.clone());
                let fact = fact!(
                    uri!("agent:codex:local"),
                    entity_uri.clone(),
                    field_uri,
                    value
                );
                fact_service
                    .state_facts(vec![fact])
                    .await
                    .expect("state_facts");
            }

            let entity = wait_for_entity_fields(entity_store.as_ref(), &entity_uri, &expected)
                .await
                .expect("entity lookup");

            prop_assert_eq!(entity.fields, expected);
            worker.abort();
            Ok::<(), proptest::test_runner::TestCaseError>(())
        })?;
    }

    #[test]
    fn inmemory_property_retracting_the_only_field_eventually_deletes_the_entity_long(
        value in any::<Value>()
    ) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async move {
            let fact_store = Arc::new(InMemoryFactStore::new());
            let fact_service = FactService::builder()
                .with_store_arc(fact_store.clone())
                .build()
                .expect("fact service");
            let entity_store: Arc<dyn EntityStore> = Arc::new(InMemoryEntityStore::new());

            assert_entity_pipeline_deletes_retracted_entity(
                &fact_service,
                entity_store,
                &uri!("spotify:album:property-delete-inmemory"),
                &uri!("spotify:displayName"),
                value,
            )
            .await;

            Ok::<(), proptest::test_runner::TestCaseError>(())
        })?;
    }
}
