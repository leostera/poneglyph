mod common;

use poneglyph::{ActiveFilter, Filter, Store, Value, fact, retraction, uri};
use poneglyph_local::LsmFactStore;
use tempfile::TempDir;

use common::{
    assert_active_and_full_log_views, assert_active_facts_can_be_narrowed_by_field_and_entity,
    assert_common_store_behavior, assert_get_facts_by_entity_uri_returns_entity_facts,
    assert_get_facts_returns_all_records_in_deterministic_order,
    assert_invalid_retractions_fail_cleanly, assert_missing_fact_returns_none,
    assert_mixed_batch_rolls_back, assert_retract_then_assert_in_same_batch_keeps_new_fact_active,
    assert_retracting_an_already_retracted_fact_is_a_noop, assert_retractions_are_append_only,
    assert_tx_ids_are_unique_per_batch, collect_active_facts, collect_facts,
};

fn make_store() -> (TempDir, LsmFactStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = LsmFactStore::open(dir.path()).expect("store");
    (dir, store)
}

#[tokio::test]
async fn lsm_state_facts_persists_a_batch_with_one_tx_id() {
    let (_dir, store) = make_store();
    assert_common_store_behavior(&store).await;
}

#[tokio::test]
async fn lsm_retractions_are_appended_and_do_not_mutate_prior_rows() {
    let (_dir, store) = make_store();
    assert_retractions_are_append_only(&store).await;
}

#[tokio::test]
async fn lsm_get_facts_can_expose_active_and_full_log_views() {
    let (_dir, store) = make_store();
    assert_active_and_full_log_views(&store).await;
}

#[tokio::test]
async fn lsm_retracting_unknown_fact_fails_the_batch() {
    let (_dir, store) = make_store();
    assert_invalid_retractions_fail_cleanly(&store).await;
}

#[tokio::test]
async fn lsm_mixed_batch_rolls_back_if_any_write_is_invalid() {
    let (_dir, store) = make_store();
    assert_mixed_batch_rolls_back(&store).await;
}

#[tokio::test]
async fn lsm_get_facts_returns_all_records_in_deterministic_order() {
    let (_dir, store) = make_store();
    assert_get_facts_returns_all_records_in_deterministic_order(&store).await;
}

#[tokio::test]
async fn lsm_get_fact_returns_none_for_unknown_id() {
    let (_dir, store) = make_store();
    assert_missing_fact_returns_none(&store).await;
}

#[tokio::test]
async fn lsm_tx_ids_are_unique_per_batch() {
    let (_dir, store) = make_store();
    assert_tx_ids_are_unique_per_batch(&store).await;
}

#[tokio::test]
async fn lsm_get_facts_by_entity_uri_returns_entity_facts() {
    let (_dir, store) = make_store();
    assert_get_facts_by_entity_uri_returns_entity_facts(&store).await;
}

#[tokio::test]
async fn lsm_retracting_an_already_retracted_fact_is_a_noop() {
    let (_dir, store) = make_store();
    assert_retracting_an_already_retracted_fact_is_a_noop(&store).await;
}

#[tokio::test]
async fn lsm_retract_then_assert_in_same_batch_keeps_new_fact_active() {
    let (_dir, store) = make_store();
    assert_retract_then_assert_in_same_batch_keeps_new_fact_active(&store).await;
}

#[tokio::test]
async fn lsm_active_facts_can_be_narrowed_by_field_and_entity() {
    let (_dir, store) = make_store();
    assert_active_facts_can_be_narrowed_by_field_and_entity(&store).await;
}

#[tokio::test]
async fn lsm_compaction_preserves_reopenable_log_and_active_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = LsmFactStore::open(dir.path()).expect("store");
    let entity = uri!("compact:item:one");
    let field = uri!("compact:name");
    let value = Value::text("one");

    store
        .state_facts_vec(vec![fact!(entity.clone(), field.clone(), value.clone())])
        .await
        .expect("assert");
    store.flush().expect("flush assertion");
    store
        .state_facts_vec(vec![retraction!(entity.clone(), field, value)])
        .await
        .expect("retract");
    store.flush().expect("flush retraction");
    store.compact().expect("compact");
    drop(store);

    let store = LsmFactStore::open(dir.path()).expect("reopen");
    let log = collect_facts(
        store
            .get_facts(Filter::ByEntityUri(entity.clone()))
            .await
            .expect("log"),
    )
    .await
    .expect("collect log");
    assert_eq!(log.len(), 2, "compaction preserves append-only fact log");

    let active = collect_active_facts(
        store
            .get_active_facts(ActiveFilter::ByEntity(entity))
            .await
            .expect("active"),
    )
    .await
    .expect("collect active");
    assert!(
        active.is_empty(),
        "compaction preserves retracted active state"
    );
}
