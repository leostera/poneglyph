use std::collections::BTreeMap;

use poneglyph::{
    ActiveFilter, Entity, FactService, Filter, Projection, ProjectionBatch, Store, Value, fact,
    retraction, uri,
};
use tempfile::tempdir;

#[tokio::test]
async fn fact_adapter_preserves_append_only_retraction_semantics() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = poneglyph::Workspace::at(tempdir.path());
    workspace.ensure().expect("workspace");
    let store = poneglyph_local::LocalWorkspace::from_workspace(workspace.clone())
        .fact_store()
        .await
        .expect("fact store");
    let service = FactService::builder()
        .with_store_arc(store.clone())
        .build()
        .expect("fact service");

    let entity = uri!("person", "alice");
    let field = uri!("person", "name");
    let value = Value::text("Alice");

    service
        .state_facts(vec![fact!(entity.clone(), field.clone(), value.clone())])
        .await
        .expect("state fact");
    service
        .state_facts(vec![retraction!(entity.clone(), field.clone(), value)])
        .await
        .expect("retract fact");

    let all = collect_facts(&*store, Filter::ByEntityUri(entity.clone())).await;
    assert_eq!(all.len(), 2, "retraction appends a second fact");
    assert!(all.iter().any(|fact| !fact.retraction));
    assert!(all.iter().any(|fact| fact.retraction));

    let active = store
        .get_active_facts(ActiveFilter::ByEntity(entity))
        .await
        .expect("active facts");
    assert_eq!(collect_active_count(active).await, 0);
}

#[tokio::test]
async fn entity_adapter_round_trips_replayable_projection_rows() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = poneglyph::Workspace::at(tempdir.path());
    workspace.ensure().expect("workspace");
    let store = poneglyph_local::LocalWorkspace::from_workspace(workspace.clone())
        .entity_store()
        .await
        .expect("entity store");

    let uri = uri!("person", "alice");
    let name = uri!("person", "name");
    let entity = Entity {
        uri: uri.clone(),
        namespace: "person".to_string(),
        kind: "alice".to_string(),
        fields: BTreeMap::from([(name, Value::text("Alice"))]),
    };

    store
        .put_entity(entity.clone(), Some(uri!("poneglyph", "tx")))
        .await
        .expect("put entity");

    assert_eq!(
        store.get_entity(&uri).await.expect("get entity"),
        Some(entity)
    );
    assert_eq!(
        store
            .list_entities(10, 0)
            .await
            .expect("list entities")
            .len(),
        1
    );

    store.delete_entity(&uri).await.expect("delete entity");
    assert_eq!(store.get_entity(&uri).await.expect("get deleted"), None);
}

#[tokio::test]
async fn search_adapter_indexes_and_removes_projection_rows() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = poneglyph::Workspace::at(tempdir.path());
    workspace.ensure().expect("workspace");
    let projection = poneglyph_local::LocalWorkspace::from_workspace(workspace.clone())
        .search_projection()
        .expect("search projection");

    let uri = uri!("person", "alice");
    let entity = Entity {
        uri: uri.clone(),
        namespace: "person".to_string(),
        kind: "alice".to_string(),
        fields: BTreeMap::from([(uri!("person", "name"), Value::text("Alice Liddell"))]),
    };

    projection
        .handle_events(ProjectionBatch {
            entities: vec![entity],
        })
        .await
        .expect("index entity");

    let hits = projection.search("Alice", 10).expect("search hits");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].entity_uri, uri);

    projection
        .handle_events(ProjectionBatch {
            entities: vec![Entity {
                uri: uri.clone(),
                namespace: "person".to_string(),
                kind: "alice".to_string(),
                fields: BTreeMap::new(),
            }],
        })
        .await
        .expect("remove entity");

    assert!(
        projection
            .search("Alice", 10)
            .expect("search removed")
            .is_empty(),
        "empty entity updates remove indexed documents"
    );
}

async fn collect_facts(store: &dyn Store, filter: Filter) -> Vec<poneglyph::Fact> {
    let mut stream = store.get_facts(filter).await.expect("facts");
    let mut facts = Vec::new();
    while let Some(fact) = stream.recv().await {
        facts.push(fact.expect("fact"));
    }
    facts
}

async fn collect_active_count(
    mut stream: tokio::sync::mpsc::Receiver<poneglyph::PoneResult<poneglyph::ActiveFact>>,
) -> usize {
    let mut count = 0;
    while let Some(fact) = stream.recv().await {
        fact.expect("active fact");
        count += 1;
    }
    count
}
