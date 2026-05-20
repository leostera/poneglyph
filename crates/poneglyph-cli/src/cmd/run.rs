use anyhow::Result;
use clap::Args;
use poneglyph::Workspace;
use tracing::info;

use crate::{config::PoneglyphDaemonConfig, daemon::Daemon};

#[derive(Debug, Clone, Default, Args)]
#[command(name = "run", about = "Run the Poneglyph daemon")]
pub struct Run {}

impl Run {
    pub async fn run(self, workspace: Workspace, config: PoneglyphDaemonConfig) -> Result<()> {
        info!("initializing poneglyph daemon");

        let daemon = Daemon::builder()
            .with_workspace(workspace)
            .with_config(config)
            .build()
            .await?;

        daemon.run().await
    }
}
