use poneglyph::{Value, fact, uri};
use poneglyph_local::LocalWorkspace;
use tempfile::tempdir;

#[tokio::test]
async fn disk_backed_runtime_states_and_queries_facts_through_library_api() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = LocalWorkspace::at(tempdir.path());

    let runtime = workspace.open().await.expect("runtime");

    runtime
        .state_facts(vec![fact!(
            uri!("memory:item:first-note"),
            uri!("memory:title"),
            Value::text("First note")
        )])
        .await
        .expect("state fact");

    let rows = runtime
        .query_str(r#"memory:title(File, "First note")"#)
        .await
        .expect("query");

    assert_eq!(rows.len(), 1);
    assert!(
        workspace
            .workspace()
            .store_dir()
            .join("facts.lsm/facts.wal")
            .exists()
    );
}
