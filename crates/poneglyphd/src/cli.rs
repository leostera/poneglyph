use std::path::PathBuf;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};

use crate::daemon::Daemon;

#[derive(Debug, Parser)]
#[command(name = "poneglyphd")]
#[command(about = "Run the Poneglyph daemon")]
pub struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the daemon runtime and wait for shutdown.
    Run(RunArgs),
}

#[derive(Debug, Clone, Args)]
pub struct RunArgs {
    /// Override the workspace root. Defaults to ~/.poneglyph.
    #[arg(long)]
    pub workspace: Option<PathBuf>,
}

impl Cli {
    pub async fn run(self) -> Result<()> {
        match self.command {
            Command::Run(args) => Daemon::open(args).await?.run().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::Cli;

    #[test]
    fn cli_parses_run_command() {
        let cli = Cli::try_parse_from(["poneglyphd", "run"]).expect("cli");

        let rendered = format!("{cli:?}");
        assert!(rendered.contains("Run"));
        assert!(rendered.contains("workspace: None"));
    }

    #[test]
    fn cli_parses_run_workspace_override() {
        let cli = Cli::try_parse_from(["poneglyphd", "run", "--workspace", "/tmp/poneglyph"])
            .expect("cli");

        let rendered = format!("{cli:?}");
        assert!(rendered.contains("Run"));
        assert!(rendered.contains("/tmp/poneglyph"));
    }
}
