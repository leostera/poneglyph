use std::path::PathBuf;

use poneglyph::{PoneResult, Value, fact, uri};
use poneglyph_local::LocalWorkspace;

#[tokio::main]
async fn main() -> PoneResult<()> {
    let workspace_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("./agent-memory.poneglyph"));
    let runtime = LocalWorkspace::at(workspace_path).open().await?;

    runtime
        .state_facts(vec![fact!(
            uri!("memory:item:first-note"),
            uri!("memory:title"),
            Value::text("First note")
        )])
        .await?;

    let rows = runtime
        .query_str(r#"memory:title(File, "First note")"#)
        .await?;
    println!("matched {} memory item(s)", rows.len());

    Ok(())
}
