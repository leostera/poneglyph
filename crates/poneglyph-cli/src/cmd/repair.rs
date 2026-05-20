use anyhow::Result;
use clap::Args;
use poneglyph_core::{Poneglyph, Workspace};
use tracing::info;

use crate::config::PoneglyphDaemonConfig;

#[derive(Debug, Clone, Default, Args)]
#[command(name = "repair", about = "Repair the Poneglyph database")]
pub struct Repair {}

impl Repair {
    pub async fn run(self, workspace: Workspace, config: PoneglyphDaemonConfig) -> Result<()> {
        info!("initializing poneglyph daemon");

        let poneglyph = Poneglyph::builder()
            .with_workspace(workspace)
            .with_config(config.poneglyph)
            .build()
            .await?;

        poneglyph.repair().await?;

        Ok(())
    }
}
