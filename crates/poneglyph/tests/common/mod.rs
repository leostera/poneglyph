#![allow(dead_code)]

pub mod properties;

use std::collections::BTreeMap;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::yield_now;
use tokio::time::timeout;

use poneglyph::{
    ActiveFact, ActiveFilter, Consolidator, Entity, EntityStore, Fact, FactService, Filter,
    PoneResult, Store, Uri, Value, fact, uri,
};

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

pub async fn wait_for_entity(
    store: &(impl EntityStore + ?Sized),
    entity_uri: &Uri,
) -> PoneResult<Option<Entity>> {
    timeout(Duration::from_secs(1), async {
        loop {
            let entity = store.get_entity(entity_uri).await?;
            if entity.is_some() {
                return Ok(entity);
            }
            yield_now().await;
        }
    })
    .await
    .expect("entity eventually materializes")
}

pub async fn wait_for_entity_fields(
    store: &(impl EntityStore + ?Sized),
    entity_uri: &Uri,
    expected_fields: &BTreeMap<Uri, Value>,
) -> PoneResult<Entity> {
    timeout(Duration::from_secs(1), async {
        loop {
            if let Some(entity) = store.get_entity(entity_uri).await?
                && entity.fields == *expected_fields
            {
                return Ok(entity);
            }
            yield_now().await;
        }
    })
    .await
    .expect("entity eventually reaches expected fields")
}

pub async fn wait_for_entity_deletion(
    store: &(impl EntityStore + ?Sized),
    entity_uri: &Uri,
) -> PoneResult<()> {
    timeout(Duration::from_secs(1), async {
        loop {
            if store.get_entity(entity_uri).await?.is_none() {
                return Ok(());
            }
            yield_now().await;
        }
    })
    .await
    .expect("entity eventually disappears")
}

pub fn end_to_end_assertion(entity_uri: Uri, field_uri: Uri, value: Value) -> Fact {
    fact!(uri!("agent:codex:local"), entity_uri, field_uri, value)
}

pub fn end_to_end_retraction(entity_uri: Uri, field_uri: Uri, value: Value) -> Fact {
    let mut fact = end_to_end_assertion(entity_uri, field_uri, value);
    fact.retraction = true;
    fact
}

pub fn expected_entity_fields(assertions: &[(Uri, Value)]) -> BTreeMap<Uri, Value> {
    let mut fields = BTreeMap::new();
    for (field, value) in assertions {
        fields.insert(field.clone(), value.clone());
    }
    fields
}

pub async fn assert_entity_pipeline_materializes_latest_values(
    fact_service: &FactService,
    entity_store: std::sync::Arc<dyn EntityStore>,
    entity_uri: &Uri,
    assertions: Vec<(Uri, Value)>,
) {
    let worker = Consolidator::builder()
        .with_entity_store_arc(entity_store.clone())
        .with_fact_subscription(fact_service.subscribe())
        .build()
        .expect("consolidator")
        .spawn();

    for (field_uri, value) in assertions.clone() {
        fact_service
            .state_facts(fact_channel(vec![end_to_end_assertion(
                entity_uri.clone(),
                field_uri,
                value,
            )]))
            .await
            .expect("state_facts");
    }

    let expected_fields = expected_entity_fields(&assertions);
    let entity = wait_for_entity_fields(entity_store.as_ref(), entity_uri, &expected_fields)
        .await
        .expect("entity lookup");

    assert_eq!(entity.uri, *entity_uri);
    assert_eq!(entity.fields, expected_fields);

    worker.abort();
}

pub async fn assert_entity_pipeline_deletes_retracted_entity(
    fact_service: &FactService,
    entity_store: std::sync::Arc<dyn EntityStore>,
    entity_uri: &Uri,
    field_uri: &Uri,
    value: Value,
) {
    let worker = Consolidator::builder()
        .with_entity_store_arc(entity_store.clone())
        .with_fact_subscription(fact_service.subscribe())
        .build()
        .expect("consolidator")
        .spawn();

    fact_service
        .state_facts(fact_channel(vec![end_to_end_assertion(
            entity_uri.clone(),
            field_uri.clone(),
            value.clone(),
        )]))
        .await
        .expect("assert");
    wait_for_entity(entity_store.as_ref(), entity_uri)
        .await
        .expect("entity lookup")
        .expect("entity");

    fact_service
        .state_facts(fact_channel(vec![end_to_end_retraction(
            entity_uri.clone(),
            field_uri.clone(),
            value,
        )]))
        .await
        .expect("retract");

    wait_for_entity_deletion(entity_store.as_ref(), entity_uri)
        .await
        .expect("entity deletion");

    worker.abort();
}

pub async fn collect_facts(
    mut receiver: mpsc::Receiver<PoneResult<Fact>>,
) -> PoneResult<Vec<Fact>> {
    let mut facts = Vec::new();
    while let Some(fact) = receiver.recv().await {
        facts.push(fact?);
    }
    Ok(facts)
}

pub async fn get_fact_by_id(store: &impl Store, fact_id: &Uri) -> PoneResult<Option<Fact>> {
    Ok(
        collect_facts(store.get_facts(Filter::ById(fact_id.clone())).await?)
            .await?
            .into_iter()
            .next(),
    )
}

pub async fn get_facts_by_tx(store: &impl Store, tx_id: &Uri) -> PoneResult<Vec<Fact>> {
    collect_facts(store.get_facts(Filter::ByTx(tx_id.clone())).await?).await
}

pub async fn get_facts_by_entity_uri(
    store: &impl Store,
    entity_uri: &Uri,
) -> PoneResult<Vec<Fact>> {
    collect_facts(
        store
            .get_facts(Filter::ByEntityUri(entity_uri.clone()))
            .await?,
    )
    .await
}

pub async fn collect_active_facts(
    mut receiver: mpsc::Receiver<PoneResult<ActiveFact>>,
) -> PoneResult<Vec<ActiveFact>> {
    let mut facts = Vec::new();
    while let Some(fact) = receiver.recv().await {
        facts.push(fact?);
    }
    Ok(facts)
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
    let (tx_id, _committed) = store
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
    let (asserted_tx, _asserted_batch) = store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("assert");
    let asserted = get_facts_by_tx(store, &asserted_tx)
        .await
        .expect("asserted facts")
        .into_iter()
        .next()
        .expect("fact");

    let (retraction_tx, _retraction_batch) = store
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
    let (asserted_tx, _asserted_batch) = store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("assert");
    let asserted = get_facts_by_tx(store, &asserted_tx)
        .await
        .expect("asserted facts")
        .into_iter()
        .next()
        .expect("fact");

    let (retraction_tx, _retraction_batch) = store
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

    assert!(matches!(error, poneglyph::Error::CannotRetractUnknownFact));
}

pub async fn assert_mixed_batch_rolls_back(store: &impl Store) {
    let error = store
        .state_facts(fact_channel(vec![
            assertion(Value::text("2112")),
            retraction(Value::text("missing")),
        ]))
        .await
        .expect_err("batch should fail");

    assert!(matches!(error, poneglyph::Error::CannotRetractUnknownFact));
}

pub async fn assert_get_facts_returns_all_records_in_deterministic_order(store: &impl Store) {
    let (tx_id, _committed) = store
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
    facts.sort_by(|left, right| {
        right
            .stated_at
            .cmp(&left.stated_at)
            .then_with(|| right.fact_id.as_str().cmp(left.fact_id.as_str()))
    });
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
    let (first, _first_batch) = store
        .state_facts(fact_channel(vec![assertion(Value::text("2112"))]))
        .await
        .expect("first batch");
    let (second, _second_batch) = store
        .state_facts(fact_channel(vec![assertion(Value::integer(1976))]))
        .await
        .expect("second batch");

    assert_ne!(first, second);
}

pub async fn assert_get_facts_by_entity_uri_returns_entity_facts(store: &impl Store) {
    let (tx_id, _committed) = store
        .state_facts(fact_channel(vec![
            assertion(Value::text("2112")),
            Fact::builder()
                .source(actor())
                .entity(uri!("spotify:artist:2910301nxo"))
                .field(field())
                .value(Value::text("Rush"))
                .build()
                .expect("fact"),
        ]))
        .await
        .expect("state_facts");

    let entity_facts = get_facts_by_entity_uri(store, &entity())
        .await
        .expect("entity facts");
    let tx_facts = get_facts_by_tx(store, &tx_id).await.expect("tx facts");

    assert_eq!(entity_facts.len(), 1);
    assert_eq!(entity_facts[0].entity, entity());
    assert_eq!(tx_facts.len(), 2);
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

    let (tx_id, _noop_batch) = store
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

    let (tx_id, _mixed_batch) = store
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

pub async fn assert_active_facts_can_be_narrowed_by_field_and_entity(store: &impl Store) {
    let display_name = field();
    let album_2112 = entity();
    let album_signals = uri!("spotify:album:signals");

    store
        .state_facts(fact_channel(vec![
            Fact::builder()
                .source(actor())
                .entity(album_2112.clone())
                .field(display_name.clone())
                .value(Value::text("2112"))
                .build()
                .expect("fact"),
            Fact::builder()
                .source(actor())
                .entity(album_signals.clone())
                .field(display_name.clone())
                .value(Value::text("Signals"))
                .build()
                .expect("fact"),
        ]))
        .await
        .expect("state_facts");

    let by_field_and_entity = collect_active_facts(
        store
            .get_active_facts(ActiveFilter::ByFieldEntity {
                field: display_name.clone(),
                entity: album_signals.clone(),
            })
            .await
            .expect("active facts"),
    )
    .await
    .expect("collect active facts");
    assert_eq!(by_field_and_entity.len(), 1);
    assert_eq!(by_field_and_entity[0].entity, album_signals);
    assert_eq!(by_field_and_entity[0].value, Value::text("Signals"));

    let by_field_entity_value = collect_active_facts(
        store
            .get_active_facts(ActiveFilter::ByFieldEntityValue {
                field: display_name,
                entity: album_2112.clone(),
                value: Value::text("2112"),
            })
            .await
            .expect("active facts"),
    )
    .await
    .expect("collect active facts");
    assert_eq!(by_field_entity_value.len(), 1);
    assert_eq!(by_field_entity_value[0].entity, album_2112);
    assert_eq!(by_field_entity_value[0].value, Value::text("2112"));
}
