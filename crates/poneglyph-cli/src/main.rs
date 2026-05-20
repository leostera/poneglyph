mod cli;
mod client;
mod cmd;
mod config;
mod config_cmd;
mod daemon;
mod entity_cmd;
mod fact_cmd;
mod query_cmd;
mod schema_cmd;
mod server;
mod tracing;
mod util;

use anyhow::Result;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    cli::Cli::parse().run().await
}
