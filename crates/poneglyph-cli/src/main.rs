mod api;
mod cli;
mod client;
mod cmd;
mod config;
mod config_cmd;
mod daemon;
mod server;

use anyhow::Result;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    cli::Cli::parse().run().await
}
