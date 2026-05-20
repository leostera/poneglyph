mod common;

use poneglyph_core::SqliteFactStore;
use tempfile::TempDir;

use common::{
    assert_active_and_full_log_views, assert_active_facts_can_be_narrowed_by_field_and_entity,
    assert_common_store_behavior, assert_get_facts_by_entity_uri_returns_entity_facts,
    assert_get_facts_returns_all_records_in_deterministic_order,
    assert_invalid_retractions_fail_cleanly, assert_missing_fact_returns_none,
    assert_mixed_batch_rolls_back, assert_retract_then_assert_in_same_batch_keeps_new_fact_active,
    assert_retracting_an_already_retracted_fact_is_a_noop, assert_retractions_are_append_only,
    assert_tx_ids_are_unique_per_batch,
};

async fn make_store() -> (TempDir, SqliteFactStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteFactStore::open(dir.path()).await.expect("store");
    (dir, store)
}

#[tokio::test]
async fn sqlite_state_facts_persists_a_batch_with_one_tx_id() {
    let (_dir, store) = make_store().await;
    assert_common_store_behavior(&store).await;
}

#[tokio::test]
async fn sqlite_retractions_are_appended_and_do_not_mutate_prior_rows() {
    let (_dir, store) = make_store().await;
    assert_retractions_are_append_only(&store).await;
}

#[tokio::test]
async fn sqlite_get_facts_can_expose_active_and_full_log_views() {
    let (_dir, store) = make_store().await;
    assert_active_and_full_log_views(&store).await;
}

#[tokio::test]
async fn sqlite_retracting_unknown_fact_fails_the_batch() {
    let (_dir, store) = make_store().await;
    assert_invalid_retractions_fail_cleanly(&store).await;
}

#[tokio::test]
async fn sqlite_mixed_batch_rolls_back_if_any_write_is_invalid() {
    let (_dir, store) = make_store().await;
    assert_mixed_batch_rolls_back(&store).await;
}

#[tokio::test]
async fn sqlite_get_facts_returns_all_records_in_deterministic_order() {
    let (_dir, store) = make_store().await;
    assert_get_facts_returns_all_records_in_deterministic_order(&store).await;
}

#[tokio::test]
async fn sqlite_get_fact_returns_none_for_unknown_id() {
    let (_dir, store) = make_store().await;
    assert_missing_fact_returns_none(&store).await;
}

#[tokio::test]
async fn sqlite_tx_ids_are_unique_per_batch() {
    let (_dir, store) = make_store().await;
    assert_tx_ids_are_unique_per_batch(&store).await;
}

#[tokio::test]
async fn sqlite_get_facts_by_entity_uri_returns_entity_facts() {
    let (_dir, store) = make_store().await;
    assert_get_facts_by_entity_uri_returns_entity_facts(&store).await;
}

#[tokio::test]
async fn sqlite_retracting_an_already_retracted_fact_is_a_noop() {
    let (_dir, store) = make_store().await;
    assert_retracting_an_already_retracted_fact_is_a_noop(&store).await;
}

#[tokio::test]
async fn sqlite_retract_then_assert_in_same_batch_keeps_new_fact_active() {
    let (_dir, store) = make_store().await;
    assert_retract_then_assert_in_same_batch_keeps_new_fact_active(&store).await;
}

#[tokio::test]
async fn sqlite_active_facts_can_be_narrowed_by_field_and_entity() {
    let (_dir, store) = make_store().await;
    assert_active_facts_can_be_narrowed_by_field_and_entity(&store).await;
}
