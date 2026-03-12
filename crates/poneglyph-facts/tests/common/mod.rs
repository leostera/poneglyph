#![allow(dead_code)]

pub mod properties;

use anyhow::Result;
use tokio::sync::mpsc;

use poneglyph_facts::{Fact, Filter, Store, Uri, Value, uri};

pub fn actor() -> Uri {
    uri!("agent:codex:local")
}

pub fn entity() -> Uri {
    uri!("spotify:album:1xndb8d9an")
}

pub fn field() -> Uri {
    uri!("spotify:displayName")
}

pub fn release_year_field() -> Uri {
    uri!("spotify:releaseYear")
}

pub fn fact_channel(facts: Vec<Fact>) -> mpsc::Receiver<Fact> {
    let (tx, rx) = mpsc::channel(facts.len().max(1));
    tokio::spawn(async move {
        for fact in facts {
            if tx.send(fact).await.is_err() {
                break;
            }
        }
    });
    rx
}

pub async fn collect_facts(mut receiver: poneglyph_facts::FactReceiver) -> Result<Vec<Fact>> {
    let mut facts = Vec::new();
    while let Some(fact) = receiver.recv().await {
        facts.push(fact?);
    }
    Ok(facts)
}

pub async fn get_fact_by_id(store: &impl Store, fact_id: &Uri) -> Result<Option<Fact>> {
    Ok(
        collect_facts(store.get_facts(Filter::ById(fact_id.clone())).await?)
            .await?
            .into_iter()
            .next(),
    )
}

pub async fn get_facts_by_tx(store: &impl Store, tx_id: &Uri) -> Result<Vec<Fact>> {
    collect_facts(store.get_facts(Filter::ByTx(tx_id.clone())).await?).await
}

pub fn assertion(value: Value) -> Fact {
    Fact::builder()
        .source(actor())
        .entity(entity())
        .field(field())
        .value(value)
        .build()
        .expect("assertion")
}

pub fn assertion_with_field(field: Uri, value: Value) -> Fact {
    Fact::builder()
        .source(actor())
        .entity(entity())
        .field(field)
        .value(value)
        .build()
        .expect("assertion")
}

pub fn retraction(value: Value) -> Fact {
    Fact::builder()
        .source(actor())
        .entity(entity())
        .field(field())
        .value(value)
        .retract()
        .build()
        .expect("retraction")
}

pub async fn assert_common_store_behavior(store: &impl Store) {
    let tx_id = store
        .state_facts(fact_channel(vec![
            assertion(Value::text("2112")),
            assertion_with_field(release_year_field(), Value::integer(1976)),
        ]))
        .await
        .expect("state_facts");

    let facts = get_facts_by_tx(store, &tx_id).await.expect("batch facts");
    assert_eq!(facts.len(), 2);
    assert!(tx_id.as_str().starts_with("poneglyph:tx:"));
    assert!(facts.iter().all(|fact| fact.tx_id.as_ref() == Some(&tx_id)));
    assert!(facts.iter().all(|fact| !fact.retraction));
}

pub async fn assert_retractions_are_append_only(store: &impl Store) {
    let asserted_tx = store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("assert");
    let asserted = get_facts_by_tx(store, &asserted_tx)
        .await
        .expect("asserted facts")
        .into_iter()
        .next()
        .expect("fact");

    let retraction_tx = store
        .state_facts(fact_channel(vec![retraction(Value::text("2112"))]))
        .await
        .expect("retract");
    let retraction = get_facts_by_tx(store, &retraction_tx)
        .await
        .expect("retraction facts")
        .into_iter()
        .next()
        .expect("retraction");

    let original = get_fact_by_id(store, &asserted.fact_id)
        .await
        .expect("query")
        .expect("stored fact");

    assert!(!original.retraction);
    assert_eq!(original.value, Value::text("2112"));
    assert!(retraction.retraction);
}

pub async fn assert_active_and_full_log_views(store: &impl Store) {
    let asserted_tx = store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("assert");
    let asserted = get_facts_by_tx(store, &asserted_tx)
        .await
        .expect("asserted facts")
        .into_iter()
        .next()
        .expect("fact");

    let retraction_tx = store
        .state_facts(fact_channel(vec![retraction(Value::text("2112"))]))
        .await
        .expect("retract");

    let _original = get_fact_by_id(store, &asserted.fact_id)
        .await
        .expect("query")
        .expect("fact");
    let retraction = get_facts_by_tx(store, &retraction_tx)
        .await
        .expect("retraction facts")
        .into_iter()
        .next()
        .expect("retraction");

    assert!(retraction.retraction);
}

pub async fn assert_invalid_retractions_fail_cleanly(store: &impl Store) {
    let error = store
        .state_facts(fact_channel(vec![retraction(Value::text("missing"))]))
        .await
        .expect_err("unknown retraction should fail");

    assert!(error.to_string().contains("cannot retract unknown fact"));
}

pub async fn assert_mixed_batch_rolls_back(store: &impl Store) {
    let error = store
        .state_facts(fact_channel(vec![
            assertion(Value::text("2112")),
            retraction(Value::text("missing")),
        ]))
        .await
        .expect_err("batch should fail");

    assert!(error.to_string().contains("cannot retract unknown fact"));
}

pub async fn assert_get_facts_returns_all_records_in_deterministic_order(store: &impl Store) {
    let tx_id = store
        .state_facts(fact_channel(vec![
            assertion(Value::text("2112")),
            assertion_with_field(release_year_field(), Value::integer(1976)),
        ]))
        .await
        .expect("state_facts");

    let mut facts = get_facts_by_tx(store, &tx_id).await.expect("facts");
    let returned_ids = facts
        .iter()
        .map(|fact| fact.fact_id.clone())
        .collect::<Vec<_>>();
    facts.sort_by(|left, right| right.fact_id.as_str().cmp(left.fact_id.as_str()));
    let expected_ids = facts
        .iter()
        .map(|fact| fact.fact_id.clone())
        .collect::<Vec<_>>();

    assert_eq!(returned_ids, expected_ids);
}

pub async fn assert_missing_fact_returns_none(store: &impl Store) {
    let fact = get_fact_by_id(store, &uri!("poneglyph:fact:missing"))
        .await
        .expect("query");

    assert_eq!(fact, None);
}

pub async fn assert_tx_ids_are_unique_per_batch(store: &impl Store) {
    let first = store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("first batch");
    let second = store
        .state_facts(fact_channel(vec![assertion(Value::integer(1976))]))
        .await
        .expect("second batch");

    assert_ne!(first, second);
}

pub async fn assert_retracting_an_already_retracted_fact_is_a_noop(store: &impl Store) {
    store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("assert");
    store
        .state_facts(fact_channel(vec![retraction(Value::text("2112"))]))
        .await
        .expect("first retraction");

    let tx_id = store
        .state_facts(fact_channel(vec![retraction(Value::text("2112"))]))
        .await
        .expect("noop retraction");

    let facts = get_facts_by_tx(store, &tx_id).await.expect("tx facts");
    assert!(facts.is_empty());
}

pub async fn assert_retract_then_assert_in_same_batch_keeps_new_fact_active(store: &impl Store) {
    store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("assert");

    let tx_id = store
        .state_facts(fact_channel(vec![
            retraction(Value::text("2112")),
            assertion(Value::text("2112")),
        ]))
        .await
        .expect("mixed batch");

    let batch = get_facts_by_tx(store, &tx_id).await.expect("batch");
    assert_eq!(batch.len(), 2);

    let new_assertion = batch
        .iter()
        .find(|fact| !fact.retraction)
        .expect("assertion");

    store
        .state_facts(fact_channel(vec![retraction(Value::text("2112"))]))
        .await
        .expect("follow-up retraction");

    let latest = get_fact_by_id(store, &new_assertion.fact_id)
        .await
        .expect("query");
    assert!(latest.is_some());
}
