use std::fs;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

use poneglyph_core::{Filter, Uri, Workspace};
use tempfile::tempdir;

fn poneglyph(workspace: &Path, args: &[&str]) -> String {
    let output = poneglyph_output(workspace, args);

    assert!(
        output.status.success(),
        "poneglyph {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    String::from_utf8(output.stdout).expect("utf8 stdout")
}

fn poneglyph_fails(workspace: &Path, args: &[&str]) -> String {
    let output = poneglyph_output(workspace, args);

    assert!(
        !output.status.success(),
        "poneglyph {args:?} unexpectedly succeeded\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    String::from_utf8(output.stderr).expect("utf8 stderr")
}

fn poneglyph_output(workspace: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_poneglyph"))
        .arg("--workspace")
        .arg(workspace)
        .args(args)
        .output()
        .expect("run poneglyph")
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
        &["query", r#"spotify:displayName(Album, "2112")"#, "--json"],
    );
    assert!(query.contains("spotify:album:2112"));

    let fact_id = first_fact_id(workspace, "spotify:album:2112").await;
    let retraction = poneglyph(
        workspace,
        &["fact", "retract", "--fact", &fact_id, "--json"],
    );
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

    let field = poneglyph(workspace, &["schema", "get", "music:released", "--json"]);
    assert!(field.contains("Release year."));
    assert!(field.contains("music:album"));

    let listed_json = poneglyph(workspace, &["schema", "list", "--json"]);
    assert!(listed_json.contains("\"fields\""));
    assert!(listed_json.contains("music:released"));

    let field_plain = poneglyph(workspace, &["schema", "get", "music:released"]);
    assert_eq!(field_plain.trim(), "field\tmusic:released");
}

#[tokio::test]
async fn cli_schema_apply_is_replay_safe_and_append_only() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();
    let schema_path = write_music_schema(workspace);

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);
    poneglyph(workspace, &["schema", "apply", path_str(&schema_path)]);
    let first_schema = poneglyph(workspace, &["schema", "get", "music:released"]);
    let first_fact_count = count_facts_for_entity(workspace, "music:released").await;

    poneglyph(workspace, &["schema", "apply", path_str(&schema_path)]);
    let second_schema = poneglyph(workspace, &["schema", "get", "music:released"]);
    let second_fact_count = count_facts_for_entity(workspace, "music:released").await;

    assert_eq!(second_schema, first_schema);
    assert!(
        second_fact_count > first_fact_count,
        "schema apply should append facts while keeping the materialized schema stable"
    );
}

#[test]
fn cli_config_get_set_and_list_round_trips() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();
    let bind_addr = free_bind_addr();

    let config = poneglyph(
        workspace,
        &["config", "set", "poneglyph.log_level", "debug"],
    );
    assert!(config.contains("log_level = \"debug\""));
    assert_eq!(
        poneglyph(workspace, &["config", "get", "poneglyph.log_level"]).trim(),
        "debug"
    );

    let config = poneglyph(workspace, &["config", "set", "rpc.bind_addr", &bind_addr]);
    assert!(config.contains(&format!("bind_addr = \"{bind_addr}\"")));
    assert_eq!(
        poneglyph(workspace, &["config", "get", "rpc.bind_addr"]).trim(),
        bind_addr
    );

    let listed = poneglyph(workspace, &["config", "list"]);
    assert!(listed.contains("[poneglyph]"));
    assert!(listed.contains("[rpc]"));
    assert!(listed.contains(&bind_addr));

    let listed_json = poneglyph(workspace, &["config", "list", "--json"]);
    assert!(listed_json.contains("\"poneglyph\""));
    assert!(listed_json.contains("\"rpc\""));
    assert!(listed_json.contains(&bind_addr));
}

#[test]
fn cli_server_repair_initializes_workspace_storage() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);
    poneglyph(workspace, &["server", "repair"]);

    assert!(workspace.join("store/facts.db").exists());
}

#[test]
fn cli_reports_invalid_inputs() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();

    let error = poneglyph_fails(
        workspace,
        &["fact", "state", "not-a-uri", "spotify:displayName", "2112"],
    );
    assert!(error.contains("invalid uri") || error.contains("URI"));

    let error = poneglyph_fails(workspace, &["query", "not valid datalog"]);
    assert!(error.contains("query parse failed") || error.contains("parse"));

    let schema_path = workspace.join("bad-schema.json");
    fs::write(&schema_path, "{ nope").expect("write bad schema");
    let error = poneglyph_fails(workspace, &["schema", "apply", path_str(&schema_path)]);
    assert!(error.contains("expected") || error.contains("JSON") || error.contains("key"));
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

    let status_json = poneglyph(workspace, &["server", "status", "--json"]);
    assert!(status_json.contains("\"status\": \"running\""));
    assert!(status_json.contains(&workspace.display().to_string()));

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
        &["entity", "get", "spotify:album:signals", "--json"],
        "Signals",
    );
    assert!(entity.contains("spotify:displayName"));

    let entity_plain = wait_for_output(
        workspace,
        &["entity", "get", "spotify:album:signals"],
        "entity\tspotify:album:signals",
    );
    assert!(entity_plain.contains("field\tspotify:displayName"));

    let applied = poneglyph(workspace, &["schema", "apply", path_str(&schema_path)]);
    assert!(applied.contains("applied"));
    let field = poneglyph(workspace, &["schema", "get", "music:released", "--json"]);
    assert!(field.contains("Release year."));

    let fact_id = first_fact_id(workspace, "spotify:album:signals").await;
    poneglyph(workspace, &["fact", "retract", "--fact", &fact_id]);
    let query = poneglyph(
        workspace,
        &["query", r#"spotify:displayName(Album, "Signals")"#],
    );
    assert_eq!(query.trim(), "[]");

    let stopped = poneglyph(workspace, &["server", "stop", "--json"]);
    assert!(stopped.contains("\"status\": \"stopping\""));
    wait_for_offline(workspace);
    daemon.wait().expect("daemon exits");
}

#[test]
fn daemon_cli_stop_offline_fails_and_restart_from_offline_starts() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();
    let bind_addr = free_bind_addr();

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);
    poneglyph(workspace, &["config", "set", "rpc.bind_addr", &bind_addr]);

    let stop_error = poneglyph_fails(workspace, &["server", "stop"]);
    assert!(stop_error.contains("transport error") || stop_error.contains("Connection refused"));

    let restarted = poneglyph(workspace, &["server", "restart", "--json"]);
    assert!(restarted.contains("\"status\": \"restarted\""));
    let status = poneglyph(workspace, &["server", "status", "--json"]);
    assert!(status.contains("\"status\": \"running\""));
    poneglyph(workspace, &["server", "stop"]);
    wait_for_offline(workspace);
}

#[test]
fn daemon_cli_restarts_detached_server() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = tempdir.path();
    let bind_addr = free_bind_addr();

    poneglyph(workspace, &["config", "set", "poneglyph.log_level", "off"]);
    poneglyph(workspace, &["config", "set", "rpc.bind_addr", &bind_addr]);

    let restarted = poneglyph(workspace, &["server", "restart", "--json"]);
    assert!(restarted.contains("\"status\": \"restarted\""));
    let status = poneglyph(workspace, &["server", "status", "--json"]);
    assert!(status.contains("\"status\": \"running\""));
    let stopped = poneglyph(workspace, &["server", "stop", "--json"]);
    assert!(stopped.contains("\"status\": \"stopping\""));
    wait_for_offline(workspace);
}

async fn count_facts_for_entity(workspace: &Path, entity: &str) -> usize {
    let workspace = Workspace::at(workspace);
    let store = poneglyph_db::open_fact_store(&workspace)
        .await
        .expect("open fact store");
    let entity = Uri::parse(entity.to_string()).expect("entity uri");
    let mut facts = store
        .get_facts(Filter::ByEntityUri(entity))
        .await
        .expect("get facts");
    let mut count = 0;

    while let Some(fact) = facts.recv().await {
        fact.expect("fact");
        count += 1;
    }

    count
}

async fn first_fact_id(workspace: &Path, entity: &str) -> String {
    let workspace = Workspace::at(workspace);
    let store = poneglyph_db::open_fact_store(&workspace)
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
