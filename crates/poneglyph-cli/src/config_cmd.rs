use anyhow::Result;
use poneglyph_core::Workspace;
use serde_json::Value as JsonValue;

use crate::cli::ConfigCommand;
use crate::cli::ConfigSubcommand;
use crate::config::PoneglyphDaemonConfig;

pub async fn run(workspace: Workspace, command: ConfigCommand) -> Result<()> {
    match command.command {
        ConfigSubcommand::List { json } => list_config(&workspace, json).await,
        ConfigSubcommand::Get { key, json } => get_config(&workspace, &key, json).await,
        ConfigSubcommand::Set { key, value, json } => {
            set_config(&workspace, &key, value, json).await
        }
    }
}

async fn list_config(workspace: &Workspace, json: bool) -> Result<()> {
    let config = PoneglyphDaemonConfig::load_from(workspace).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&config)?);
    } else {
        println!("{}", toml::to_string_pretty(&config)?);
    }
    Ok(())
}

async fn get_config(workspace: &Workspace, key: &str, json: bool) -> Result<()> {
    let config = PoneglyphDaemonConfig::load_from(workspace).await?;
    let value = config_value(&config, key)?;
    if json {
        println!("{}", config_get_json(key, &value)?);
    } else if !value.is_null() {
        print_plain_config_value(&value);
    }
    Ok(())
}

async fn set_config(workspace: &Workspace, key: &str, value: String, json: bool) -> Result<()> {
    let mut config = PoneglyphDaemonConfig::load_from(workspace).await?;
    set_config_value(&mut config, key, value)?;
    config.save_to(workspace).await?;
    if json {
        println!("{}", config_set_json(&config, key)?);
    } else {
        println!("{}", toml::to_string_pretty(&config)?);
    }
    Ok(())
}

fn config_get_json(key: &str, value: &JsonValue) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "key": key,
        "value": value,
    }))
    .map_err(Into::into)
}

fn config_set_json(config: &PoneglyphDaemonConfig, key: &str) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "status": "updated",
        "key": key,
        "value": config_value(config, key)?,
    }))
    .map_err(Into::into)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{config_get_json, optional_string};

    #[test]
    fn optional_string_treats_empty_and_null_as_none() {
        assert_eq!(optional_string(String::new()), None);
        assert_eq!(optional_string("null".to_string()), None);
        assert_eq!(
            optional_string("debug".to_string()),
            Some("debug".to_string())
        );
    }

    #[test]
    fn config_get_json_wraps_key_and_value() {
        let json = config_get_json("rpc.bind_addr", &json!("127.0.0.1:0")).expect("json");

        assert!(json.contains(r#""key": "rpc.bind_addr""#));
        assert!(json.contains(r#""value": "127.0.0.1:0""#));
    }
}
