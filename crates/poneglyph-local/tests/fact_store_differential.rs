mod common;

use poneglyph::{ActiveFilter, Fact, Filter, Store, Value, fact, retraction, uri};
use poneglyph_local::{LsmFactStore, SqliteFactStore};
use proptest::prelude::*;

use common::{actor, collect_active_facts, collect_facts};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn sqlite_and_lsm_match_for_random_valid_operations(ops in prop::collection::vec((0usize..4, any::<bool>()), 1..32)) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async move {
            let sqlite_dir = tempfile::tempdir().expect("sqlite dir");
            let lsm_dir = tempfile::tempdir().expect("lsm dir");
            let sqlite = SqliteFactStore::open(sqlite_dir.path()).await.expect("sqlite");
            let lsm = LsmFactStore::open(lsm_dir.path()).expect("lsm");
            let mut active = std::collections::BTreeSet::new();

            for (slot, wants_retraction) in ops {
                let assertion = generated_fact(slot);
                let key = generated_key(&assertion);
                let fact = if wants_retraction && active.contains(&key) {
                    active.remove(&key);
                    Fact::builder()
                        .source(assertion.source.clone())
                        .entity(assertion.entity.clone())
                        .field(assertion.field.clone())
                        .value(assertion.value.clone())
                        .retract()
                        .build()
                        .expect("retraction")
                } else {
                    active.insert(key);
                    assertion
                };

                sqlite.state_facts_vec(vec![fact.clone()]).await.expect("sqlite state");
                lsm.state_facts_vec(vec![fact]).await.expect("lsm state");
                assert_same_facts(&sqlite, &lsm, Filter::All).await;
                assert_same_active(&sqlite, &lsm, ActiveFilter::All).await;
            }
        });
    }
}

#[tokio::test]
async fn sqlite_and_lsm_match_for_assert_retract_reassert_sequence() {
    let sqlite_dir = tempfile::tempdir().expect("sqlite dir");
    let lsm_dir = tempfile::tempdir().expect("lsm dir");
    let sqlite = SqliteFactStore::open(sqlite_dir.path())
        .await
        .expect("sqlite");
    let lsm = LsmFactStore::open(lsm_dir.path()).expect("lsm");

    let batches = vec![
        vec![
            fact!(uri!("e:one"), uri!("f:name"), Value::text("one")),
            fact!(uri!("e:one"), uri!("f:rank"), Value::integer(1)),
        ],
        vec![retraction!(
            uri!("e:one"),
            uri!("f:name"),
            Value::text("one")
        )],
        vec![fact!(uri!("e:one"), uri!("f:name"), Value::text("uno"))],
        vec![fact!(uri!("e:two"), uri!("f:name"), Value::text("two"))],
    ];

    for batch in batches {
        sqlite
            .state_facts_vec(batch.clone())
            .await
            .expect("sqlite state");
        lsm.state_facts_vec(batch).await.expect("lsm state");
    }

    assert_same_facts(&sqlite, &lsm, Filter::All).await;
    assert_same_facts(&sqlite, &lsm, Filter::ByEntityUri(uri!("e:one"))).await;
    assert_same_active(&sqlite, &lsm, ActiveFilter::All).await;
    assert_same_active(&sqlite, &lsm, ActiveFilter::ByField(uri!("f:name"))).await;
    assert_same_active(
        &sqlite,
        &lsm,
        ActiveFilter::ByFieldEntityValue {
            field: uri!("f:name"),
            entity: uri!("e:one"),
            value: Value::text("uno"),
        },
    )
    .await;
}

async fn assert_same_facts(sqlite: &SqliteFactStore, lsm: &LsmFactStore, filter: Filter) {
    let sqlite_rows = collect_facts(
        sqlite
            .get_facts(filter.clone())
            .await
            .expect("sqlite facts"),
    )
    .await
    .expect("sqlite collect");
    let lsm_rows = collect_facts(lsm.get_facts(filter).await.expect("lsm facts"))
        .await
        .expect("lsm collect");
    assert_eq!(normalize_facts(sqlite_rows), normalize_facts(lsm_rows));
}

#[tokio::test]
async fn lsm_repair_rebuilds_active_indexes_from_fact_log() {
    let lsm_dir = tempfile::tempdir().expect("lsm dir");
    let lsm = LsmFactStore::open(lsm_dir.path()).expect("lsm");
    lsm.state_facts_vec(vec![
        fact!(uri!("e:one"), uri!("f:name"), Value::text("one")),
        fact!(uri!("e:two"), uri!("f:name"), Value::text("two")),
    ])
    .await
    .expect("state");
    lsm.state_facts_vec(vec![retraction!(
        uri!("e:one"),
        uri!("f:name"),
        Value::text("one")
    )])
    .await
    .expect("retract");
    lsm.repair().await.expect("repair");

    let active = collect_active_facts(
        lsm.get_active_facts(ActiveFilter::All)
            .await
            .expect("active"),
    )
    .await
    .expect("collect");
    assert_eq!(
        normalize_active(active),
        vec![(
            "poneglyph:internal".to_string(),
            "e:two".to_string(),
            "f:name".to_string(),
            "{\"type\":\"text\",\"value\":\"two\"}".to_string(),
        )]
    );
}

async fn assert_same_active(sqlite: &SqliteFactStore, lsm: &LsmFactStore, filter: ActiveFilter) {
    let sqlite_rows = collect_active_facts(
        sqlite
            .get_active_facts(filter.clone())
            .await
            .expect("sqlite active"),
    )
    .await
    .expect("sqlite collect");
    let lsm_rows = collect_active_facts(lsm.get_active_facts(filter).await.expect("lsm active"))
        .await
        .expect("lsm collect");
    assert_eq!(normalize_active(sqlite_rows), normalize_active(lsm_rows));
}

fn generated_fact(slot: usize) -> Fact {
    Fact::builder()
        .source(actor())
        .entity(uri!("diff", &format!("entity-{slot}")))
        .field(uri!("diff:name"))
        .value(Value::text(format!("value-{slot}")))
        .build()
        .expect("fact")
}

fn generated_key(fact: &Fact) -> (String, String, String, String) {
    (
        fact.source.to_string(),
        fact.entity.to_string(),
        fact.field.to_string(),
        serde_json::to_string(&fact.value).expect("value"),
    )
}

fn normalize_facts(facts: Vec<Fact>) -> Vec<(String, String, String, String, bool)> {
    let mut rows = facts
        .into_iter()
        .map(|fact| {
            (
                fact.source.to_string(),
                fact.entity.to_string(),
                fact.field.to_string(),
                serde_json::to_string(&fact.value).expect("value"),
                fact.retraction,
            )
        })
        .collect::<Vec<_>>();
    rows.sort();
    rows
}

fn normalize_active(facts: Vec<poneglyph::ActiveFact>) -> Vec<(String, String, String, String)> {
    let mut rows = facts
        .into_iter()
        .map(|fact| {
            (
                fact.source.to_string(),
                fact.entity.to_string(),
                fact.field.to_string(),
                serde_json::to_string(&fact.value).expect("value"),
            )
        })
        .collect::<Vec<_>>();
    rows.sort();
    rows
}
