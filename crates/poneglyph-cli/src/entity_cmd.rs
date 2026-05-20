use anyhow::Result;
use poneglyph_api::proto::GetEntityRequest;
use poneglyph_core::{Uri, Workspace};

use crate::cli::{EntityCommand, EntitySubcommand};
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: EntityCommand,
) -> Result<()> {
    match command.command {
        EntitySubcommand::Get { uri } => {
            let json = match daemon_client(&config).await {
                Ok(mut client) => {
                    client
                        .get_entity(GetEntityRequest { uri })
                        .await?
                        .into_inner()
                        .json
                }
                Err(_) => {
                    let poneglyph = open_runtime(workspace, config).await?;
                    match poneglyph.get_entity(&parse_uri(&uri)?).await? {
                        Some(entity) => serde_json::to_string_pretty(&entity)?,
                        None => "null".to_string(),
                    }
                }
            };
            println!("{json}");
        }
    }
    Ok(())
}

fn parse_uri(value: &str) -> Result<Uri> {
    Uri::parse(value.to_string()).map_err(Into::into)
}
