use poneglyph_core::{Value, Workspace, fact, uri};
use tempfile::tempdir;

#[tokio::test]
async fn disk_backed_runtime_states_and_queries_facts_without_cli() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());

    let runtime = poneglyph_db::open_workspace(workspace.clone())
        .await
        .expect("runtime");

    runtime
        .state_facts(vec![fact!(
            uri!("code:file:main-rs"),
            uri!("code:displayName"),
            Value::text("src/main.rs")
        )])
        .await
        .expect("state fact");

    let rows = runtime
        .query_str(r#"code:displayName(File, "src/main.rs")"#)
        .await
        .expect("query");

    assert_eq!(rows.len(), 1);
    assert!(workspace.facts_db_path().exists());
}
