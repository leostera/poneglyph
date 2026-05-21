use std::path::PathBuf;

use poneglyph_core::{PoneResult, Value, Workspace, fact, uri};
use poneglyph_db::open_runtime;

#[tokio::main]
async fn main() -> PoneResult<()> {
    let workspace_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("./codedb.poneglyph"));
    let runtime = open_runtime(Workspace::at(workspace_path), Default::default()).await?;

    runtime
        .state_facts(vec![fact!(
            uri!("code:file:main-rs"),
            uri!("code:displayName"),
            Value::text("src/main.rs")
        )])
        .await?;

    let rows = runtime
        .query_str(r#"code:displayName(File, "src/main.rs")"#)
        .await?;
    println!("matched {} file(s)", rows.len());

    Ok(())
}
