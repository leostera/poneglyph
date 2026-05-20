use anyhow::Result;
use poneglyph_api::proto::QueryRequest;
use poneglyph_core::Workspace;

use crate::cli::QueryCommand;
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: QueryCommand,
) -> Result<()> {
    let _json_output = command.json;
    let json = match daemon_client(&config).await {
        Ok(mut client) => {
            client
                .query(QueryRequest {
                    expression: command.expression,
                })
                .await?
                .into_inner()
                .json
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace, config).await?;
            let result = poneglyph.query_str(&command.expression).await?;
            serde_json::to_string_pretty(result.substitutions())?
        }
    };
    println!("{json}");
    Ok(())
}
