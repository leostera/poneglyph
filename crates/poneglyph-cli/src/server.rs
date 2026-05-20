use std::process::{Command as ProcessCommand, Stdio};
use std::time::Duration;

use anyhow::Result;
use poneglyph_core::Workspace;

use poneglyph_api::proto::{ShutdownRequest, StatusRequest, StatusResponse};

use crate::client::daemon_client;
use crate::config::PoneglyphDaemonConfig;

const SHUTDOWN_POLL_ATTEMPTS: usize = 40;
const STARTUP_POLL_ATTEMPTS: usize = 80;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub async fn status(config: PoneglyphDaemonConfig, json: bool) -> Result<()> {
    match daemon_client(&config).await {
        Ok(mut client) => {
            let status = client.status(StatusRequest {}).await?.into_inner();
            print_status(&status, json)
        }
        Err(error) => print_offline_status(&error.to_string(), json),
    }
}

pub async fn stop(config: PoneglyphDaemonConfig, json: bool) -> Result<()> {
    match stop_daemon(&config).await {
        Ok(status) => print_stop_status(&status, json),
        Err(error) => {
            if json {
                println!("{}", offline_stop_json(&config, &error.to_string())?);
            }
            anyhow::bail!("daemon is not running at {}: {error}", config.rpc.bind_addr);
        }
    }
}

fn print_status(status: &StatusResponse, json: bool) -> Result<()> {
    if json {
        println!("{}", status_json(status)?);
    } else {
        println!("status: {}", status.status);
        println!("workspace: {}", status.workspace);
        println!("uptime_seconds: {}", status.uptime_seconds);
    }
    Ok(())
}

fn print_offline_status(error: &str, json: bool) -> Result<()> {
    if json {
        println!("{}", offline_status_json(error)?);
    } else {
        println!("status: offline");
        println!("error: {error}");
    }
    Ok(())
}

fn print_stop_status(status: &str, json: bool) -> Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({ "status": status }))?
        );
    } else {
        println!("status: {status}");
    }
    Ok(())
}

fn print_restart_status(config: &PoneglyphDaemonConfig, json: bool) -> Result<()> {
    if json {
        println!("{}", restart_json(config)?);
    } else {
        println!("status: restarted");
    }
    Ok(())
}

fn status_json(status: &StatusResponse) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "status": status.status,
        "workspace": status.workspace,
        "uptime_seconds": status.uptime_seconds,
    }))
    .map_err(Into::into)
}

fn offline_status_json(error: &str) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "status": "offline",
        "error": error,
    }))
    .map_err(Into::into)
}

fn offline_stop_json(config: &PoneglyphDaemonConfig, error: &str) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "status": "offline",
        "rpc_bind_addr": config.rpc.bind_addr.to_string(),
        "error": error,
    }))
    .map_err(Into::into)
}

fn restart_json(config: &PoneglyphDaemonConfig) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "status": "restarted",
        "rpc_bind_addr": config.rpc.bind_addr.to_string(),
    }))
    .map_err(Into::into)
}

async fn stop_daemon(config: &PoneglyphDaemonConfig) -> Result<String> {
    let mut client = daemon_client(config).await?;
    let response = client.shutdown(ShutdownRequest {}).await?.into_inner();
    Ok(response.status)
}

pub async fn restart(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    json: bool,
) -> Result<()> {
    if daemon_client(&config).await.is_ok() {
        stop_daemon(&config).await?;
        wait_until_offline(&config).await;
    }

    let current_exe = std::env::current_exe()?;
    ProcessCommand::new(current_exe)
        .arg("--workspace")
        .arg(workspace.root())
        .arg("server")
        .arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    wait_until_running(&config).await?;
    print_restart_status(&config, json)
}

async fn wait_until_offline(config: &PoneglyphDaemonConfig) {
    for _ in 0..SHUTDOWN_POLL_ATTEMPTS {
        if daemon_client(config).await.is_err() {
            return;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn wait_until_running(config: &PoneglyphDaemonConfig) -> Result<()> {
    let mut last_error = None;
    for _ in 0..STARTUP_POLL_ATTEMPTS {
        match daemon_client(config).await {
            Ok(mut client) => {
                if client.status(StatusRequest {}).await.is_ok() {
                    return Ok(());
                }
                last_error = Some("status RPC failed".to_string());
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    anyhow::bail!(
        "daemon did not become ready: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )
}

#[cfg(test)]
mod tests {
    use poneglyph_api::proto::StatusResponse;

    use super::{offline_status_json, status_json};

    #[test]
    fn status_json_includes_daemon_status_fields() {
        let json = status_json(&StatusResponse {
            status: "running".to_string(),
            workspace: "/tmp/poneglyph".to_string(),
            uptime_seconds: 42,
        })
        .expect("status json");

        assert!(json.contains(r#""status": "running""#));
        assert!(json.contains(r#""workspace": "/tmp/poneglyph""#));
        assert!(json.contains(r#""uptime_seconds": 42"#));
    }

    #[test]
    fn offline_status_json_wraps_error() {
        let json = offline_status_json("connection refused").expect("offline json");

        assert!(json.contains(r#""status": "offline""#));
        assert!(json.contains(r#""error": "connection refused""#));
    }
}
