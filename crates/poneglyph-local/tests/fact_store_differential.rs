mod common;

use poneglyph::{ActiveFilter, Fact, Filter, Store, Value, fact, retraction, uri};
use poneglyph_local::{LsmFactStore, SqliteFactStore};

use common::{collect_active_facts, collect_facts};

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
