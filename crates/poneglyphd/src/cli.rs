use std::path::PathBuf;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use tracing::info;

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
    /// Start an MCP stdio server over the daemon runtime.
    Mcp(McpArgs),
}

#[derive(Debug, Clone, Args)]
pub struct RunArgs {
    /// Override the workspace root. Defaults to ~/.poneglyph.
    #[arg(long)]
    pub workspace: Option<PathBuf>,
}

#[derive(Debug, Clone, Args)]
pub struct McpArgs {
    /// Override the workspace root. Defaults to ~/.poneglyph.
    #[arg(long)]
    pub workspace: Option<PathBuf>,
}

impl Cli {
    pub async fn run(self) -> Result<()> {
        match self.command {
            Command::Run(args) => {
                info!(command = "run", "dispatching daemon command");
                Daemon::open(args).await?.run().await
            }
            Command::Mcp(args) => {
                info!(command = "mcp", "dispatching daemon command");
                Daemon::open(args.into()).await?.serve_mcp().await
            }
        }
    }
}

impl From<McpArgs> for RunArgs {
    fn from(args: McpArgs) -> Self {
        Self {
            workspace: args.workspace,
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

    #[test]
    fn cli_parses_mcp_command() {
        let cli = Cli::try_parse_from(["poneglyphd", "mcp"]).expect("cli");

        let rendered = format!("{cli:?}");
        assert!(rendered.contains("Mcp"));
        assert!(rendered.contains("workspace: None"));
    }
}
