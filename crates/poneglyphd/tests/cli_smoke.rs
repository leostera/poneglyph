use std::fs;
use std::path::Path;
use std::process::Command;

use poneglyph::{Filter, Store, Uri};
use tempfile::tempdir;

fn poneglyph(workspace: &Path, args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_poneglyph"))
        .arg("--workspace")
        .arg(workspace)
        .args(args)
        .output()
        .expect("run poneglyph");

    assert!(
        output.status.success(),
        "poneglyph {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    String::from_utf8(output.stdout).expect("utf8 stdout")
}

#[tokio::test]
async fn cli_states_queries_and_retracts_facts_without_daemon() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);
    poneglyph(
        workspace,
        &[
            "fact",
            "state",
            "spotify:album:2112",
            "spotify:displayName",
            "2112",
        ],
    );

    let query = poneglyph(
        workspace,
        &["query", r#"spotify:displayName(Album, "2112")"#],
    );
    assert!(query.contains("spotify:album:2112"));

    let fact_id = first_fact_id(workspace, "spotify:album:2112").await;
    poneglyph(workspace, &["fact", "retract", "--fact", &fact_id]);

    let query = poneglyph(
        workspace,
        &["query", r#"spotify:displayName(Album, "2112")"#],
    );
    assert_eq!(query.trim(), "[]");
}

#[test]
fn cli_applies_schema_definition_without_daemon() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();
    let schema_path = workspace.join("music-schema.json");

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);
    fs::write(
        &schema_path,
        r#"
{
  "base": { "namespaces": [], "kinds": [], "fields": [] },
  "namespaces": [
    { "uri": "music:namespace", "name": "Music", "doc": "Music data." }
  ],
  "kinds": [
    { "uri": "music:album", "name": "Album", "doc": "A music album." }
  ],
  "fields": [
    {
      "uri": "music:released",
      "name": "Released",
      "doc": "Release year.",
      "same_as": null,
      "domain": "music:album",
      "range": null,
      "value_type": "number",
      "cardinality": "one",
      "deprecated": false,
      "identity": false
    }
  ]
}
"#,
    )
    .expect("write schema");

    let applied = poneglyph(workspace, &["schema", "apply", path_str(&schema_path)]);
    assert!(applied.contains("applied"));

    let field = poneglyph(workspace, &["schema", "get", "music:released"]);
    assert!(field.contains("Release year."));
    assert!(field.contains("music:album"));
}

async fn first_fact_id(workspace: &Path, entity: &str) -> String {
    let store = poneglyph::SqliteFactStore::open(workspace.join("store/facts.db"))
        .await
        .expect("open fact store");
    let entity = Uri::parse(entity.to_string()).expect("entity uri");
    let mut facts = store
        .get_facts(Filter::ByEntityUri(entity))
        .await
        .expect("get facts");

    while let Some(fact) = facts.recv().await {
        let fact = fact.expect("fact");
        if !fact.retraction && fact.field.as_str() == "spotify:displayName" {
            return fact.fact_id.to_string();
        }
    }

    panic!("expected stated fact");
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf8 path")
}
