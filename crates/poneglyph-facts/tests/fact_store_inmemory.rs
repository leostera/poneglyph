mod common;

use common::{
    assert_active_and_full_log_views, assert_common_store_behavior,
    assert_get_facts_returns_all_records_in_deterministic_order,
    assert_invalid_retractions_fail_cleanly, assert_missing_fact_returns_none,
    assert_mixed_batch_rolls_back, assert_retract_then_assert_in_same_batch_keeps_new_fact_active,
    assert_retracting_an_already_retracted_fact_is_a_noop, assert_retractions_are_append_only,
    assert_tx_ids_are_unique_per_batch,
};
use poneglyph_facts::InMemoryFactStore;

#[tokio::test]
async fn state_facts_persists_a_batch_with_one_tx_id() {
    let store = InMemoryFactStore::new();
    assert_common_store_behavior(&store).await;
}

#[tokio::test]
async fn retractions_are_appended_and_do_not_mutate_prior_rows() {
    let store = InMemoryFactStore::new();
    assert_retractions_are_append_only(&store).await;
}

#[tokio::test]
async fn list_facts_can_exclude_retracted_assertions_but_keep_log_visibility() {
    let store = InMemoryFactStore::new();
    assert_active_and_full_log_views(&store).await;
}

#[tokio::test]
async fn retracting_unknown_fact_fails_the_batch() {
    let store = InMemoryFactStore::new();
    assert_invalid_retractions_fail_cleanly(&store).await;
}

#[tokio::test]
async fn mixed_batch_rolls_back_if_any_write_is_invalid() {
    let store = InMemoryFactStore::new();
    assert_mixed_batch_rolls_back(&store).await;
}

#[tokio::test]
async fn get_facts_returns_all_records_in_deterministic_order() {
    let store = InMemoryFactStore::new();
    assert_get_facts_returns_all_records_in_deterministic_order(&store).await;
}

#[tokio::test]
async fn get_fact_returns_none_for_unknown_id() {
    let store = InMemoryFactStore::new();
    assert_missing_fact_returns_none(&store).await;
}

#[tokio::test]
async fn tx_ids_are_unique_per_batch() {
    let store = InMemoryFactStore::new();
    assert_tx_ids_are_unique_per_batch(&store).await;
}

#[tokio::test]
async fn retracting_an_already_retracted_fact_is_a_noop() {
    let store = InMemoryFactStore::new();
    assert_retracting_an_already_retracted_fact_is_a_noop(&store).await;
}

#[tokio::test]
async fn retract_then_assert_in_same_batch_keeps_new_fact_active() {
    let store = InMemoryFactStore::new();
    assert_retract_then_assert_in_same_batch_keeps_new_fact_active(&store).await;
}
