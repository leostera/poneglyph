mod api;
mod cli;
mod client;
mod cmd;
mod config;
mod daemon;

use anyhow::Result;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    cli::Cli::parse().run().await
}
