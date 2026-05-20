use std::fs;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

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
    let state = poneglyph(
        workspace,
        &[
            "fact",
            "state",
            "spotify:album:2112",
            "spotify:displayName",
            "2112",
        ],
    );
    assert!(state.contains("tx_id:"));
    assert!(state.contains("fact_id:"));

    let query = poneglyph(
        workspace,
        &["query", r#"spotify:displayName(Album, "2112")"#],
    );
    assert!(query.contains("spotify:album:2112"));

    let fact_id = first_fact_id(workspace, "spotify:album:2112").await;
    let retraction = poneglyph(workspace, &["fact", "retract", "--fact", &fact_id, "--json"]);
    assert!(retraction.contains("tx_id"));
    assert!(retraction.contains("fact_id"));

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
    let schema_path = write_music_schema(workspace);

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);

    let applied = poneglyph(workspace, &["schema", "apply", path_str(&schema_path)]);
    assert!(applied.contains("applied"));

    let field = poneglyph(workspace, &["schema", "get", "music:released"]);
    assert!(field.contains("Release year."));
    assert!(field.contains("music:album"));
}

#[tokio::test]
async fn daemon_cli_serves_status_fact_query_entity_schema_and_stop() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();
    let bind_addr = free_bind_addr();
    let schema_path = write_music_schema(workspace);

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);
    poneglyph(workspace, &["config", "set", "rpc.bind_addr", &bind_addr]);
    let mut daemon = start_daemon(workspace);

    let status = poneglyph(workspace, &["server", "status"]);
    assert!(status.contains("status: running"));
    assert!(status.contains(&workspace.display().to_string()));

    let state = poneglyph(
        workspace,
        &[
            "fact",
            "state",
            "spotify:album:signals",
            "spotify:displayName",
            "Signals",
            "--json",
        ],
    );
    assert!(state.contains("tx_id"));
    assert!(state.contains("fact_id"));
    let query = poneglyph(
        workspace,
        &["query", r#"spotify:displayName(Album, "Signals")"#],
    );
    assert!(query.contains("spotify:album:signals"));

    let entity = wait_for_output(
        workspace,
        &["entity", "get", "spotify:album:signals"],
        "Signals",
    );
    assert!(entity.contains("spotify:displayName"));

    let applied = poneglyph(workspace, &["schema", "apply", path_str(&schema_path)]);
    assert!(applied.contains("applied"));
    let field = poneglyph(workspace, &["schema", "get", "music:released"]);
    assert!(field.contains("Release year."));

    let fact_id = first_fact_id(workspace, "spotify:album:signals").await;
    poneglyph(workspace, &["fact", "retract", "--fact", &fact_id]);
    let query = poneglyph(
        workspace,
        &["query", r#"spotify:displayName(Album, "Signals")"#],
    );
    assert_eq!(query.trim(), "[]");

    poneglyph(workspace, &["server", "stop"]);
    wait_for_offline(workspace);
    daemon.wait().expect("daemon exits");
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

fn write_music_schema(workspace: &Path) -> std::path::PathBuf {
    let schema_path = workspace.join("music-schema.json");
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
    schema_path
}

fn start_daemon(workspace: &Path) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_poneglyph"))
        .arg("--workspace")
        .arg(workspace)
        .arg("server")
        .arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start daemon");

    for _ in 0..80 {
        if let Some(status) = child.try_wait().expect("daemon status") {
            panic!("daemon exited early with {status}");
        }

        let status = poneglyph(workspace, &["server", "status"]);
        if status.contains("status: running") {
            return child;
        }
        thread::sleep(Duration::from_millis(50));
    }

    let _ = child.kill();
    panic!("daemon did not start");
}

fn wait_for_output(workspace: &Path, args: &[&str], expected: &str) -> String {
    let mut last = String::new();
    for _ in 0..80 {
        last = poneglyph(workspace, args);
        if last.contains(expected) {
            return last;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("command {args:?} never contained {expected:?}; last output: {last}");
}

fn wait_for_offline(workspace: &Path) {
    for _ in 0..80 {
        let status = poneglyph(workspace, &["server", "status"]);
        if status.contains("status: offline") {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("daemon did not stop");
}

fn free_bind_addr() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind free port");
    let addr = listener.local_addr().expect("local addr");
    format!("127.0.0.1:{}", addr.port())
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf8 path")
}
