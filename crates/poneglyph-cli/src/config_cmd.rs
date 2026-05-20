use anyhow::Result;
use poneglyph_core::Workspace;
use serde_json::Value as JsonValue;

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
        ConfigSubcommand::Get { key, json } => {
            let config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            let value = config_value(&config, &key)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "key": key,
                        "value": value,
                    }))?
                );
            } else if !value.is_null() {
                print_plain_config_value(&value);
            }
            Ok(())
        }
        ConfigSubcommand::Set { key, value, json } => {
            let mut config = PoneglyphDaemonConfig::load_from(&workspace).await?;
            set_config_value(&mut config, &key, value)?;
            config.save_to(&workspace).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": "updated",
                        "key": key,
                        "value": config_value(&config, &key)?,
                    }))?
                );
            } else {
                println!("{}", toml::to_string_pretty(&config)?);
            }
            Ok(())
        }
    }
}

fn config_value(config: &PoneglyphDaemonConfig, key: &str) -> Result<JsonValue> {
    match key {
        "log_level" | "poneglyph.log_level" => Ok(config
            .poneglyph
            .log_level
            .clone()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null)),
        "rpc.bind_addr" => Ok(JsonValue::String(config.rpc.bind_addr.to_string())),
        "logging.server_log_path" => Ok(config
            .logging
            .server_log_path
            .as_ref()
            .map(|path| JsonValue::String(path.display().to_string()))
            .unwrap_or(JsonValue::Null)),
        _ => anyhow::bail!("unknown config key `{key}`"),
    }
}

fn print_plain_config_value(value: &JsonValue) {
    match value {
        JsonValue::String(value) => println!("{value}"),
        JsonValue::Null => {}
        other => println!("{other}"),
    }
}

fn set_config_value(config: &mut PoneglyphDaemonConfig, key: &str, value: String) -> Result<()> {
    match key {
        "log_level" | "poneglyph.log_level" => {
            config.poneglyph.log_level = optional_string(value);
            Ok(())
        }
        "rpc.bind_addr" => {
            config.rpc.bind_addr = value.parse()?;
            Ok(())
        }
        "logging.server_log_path" => {
            config.logging.server_log_path = optional_string(value).map(Into::into);
            Ok(())
        }
        _ => anyhow::bail!("unknown config key `{key}`"),
    }
}

fn optional_string(value: String) -> Option<String> {
    if value.is_empty() || value == "null" {
        None
    } else {
        Some(value)
    }
}
