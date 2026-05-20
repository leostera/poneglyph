use anyhow::Result;
use clap::Args;
use poneglyph_core::Workspace;
use tracing::info;

use crate::config::PoneglyphDaemonConfig;

#[derive(Debug, Clone, Default, Args)]
#[command(name = "repair", about = "Repair the Poneglyph database")]
pub struct Repair {
    /// Print machine-readable JSON.
    #[arg(long)]
    pub json: bool,
}

impl Repair {
    pub async fn run(self, workspace: Workspace, config: PoneglyphDaemonConfig) -> Result<()> {
        info!("initializing poneglyph daemon");

        poneglyph_db::repair_workspace(workspace.clone(), config.poneglyph).await?;

        if self.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": "repaired",
                    "workspace": workspace.root().display().to_string(),
                }))?
            );
        }

        Ok(())
    }
}
