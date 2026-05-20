use anyhow::Result;
use poneglyph_core::Workspace;

use crate::cli::ConfigCommand;
use crate::cli::ConfigSubcommand;
use crate::config::PoneglyphDaemonConfig;

pub async fn run(workspace: Workspace, command: ConfigCommand) -> Result<()> {
    match command.command {
        ConfigSubcommand::List { json } => {
            let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&config)?);
            } else {
                println!("{}", toml::to_string_pretty(&config)?);
            }
            Ok(())
        }
        ConfigSubcommand::Get { key } => {
            let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            match key.as_str() {
                "log_level" | "poneglyph.log_level" => {
                    if let Some(value) = config.poneglyph.log_level {
                        println!("{value}");
                    }
                    Ok(())
                }
                "rpc.bind_addr" => {
                    println!("{}", config.rpc.bind_addr);
                    Ok(())
                }
                "logging.server_log_path" => {
                    if let Some(value) = config.logging.server_log_path {
                        println!("{}", value.display());
                    }
                    Ok(())
                }
                _ => anyhow::bail!("unknown config key `{key}`"),
            }
        }
        ConfigSubcommand::Set { key, value } => {
            let mut config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            match key.as_str() {
                "log_level" | "poneglyph.log_level" => {
                    config.poneglyph.log_level = if value.is_empty() || value == "null" {
                        None
                    } else {
                        Some(value)
                    };
                    config.save_to(&workspace).await?;
                    println!("{}", toml::to_string_pretty(&config)?);
                    Ok(())
                }
                "rpc.bind_addr" => {
                    config.rpc.bind_addr = value.parse()?;
                    config.save_to(&workspace).await?;
                    println!("{}", toml::to_string_pretty(&config)?);
                    Ok(())
                }
                "logging.server_log_path" => {
                    config.logging.server_log_path = if value.is_empty() || value == "null" {
                        None
                    } else {
                        Some(value.into())
                    };
                    config.save_to(&workspace).await?;
                    println!("{}", toml::to_string_pretty(&config)?);
                    Ok(())
                }
                _ => anyhow::bail!("unknown config key `{key}`"),
            }
        }
    }
}
