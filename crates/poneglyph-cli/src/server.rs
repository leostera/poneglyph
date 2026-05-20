use std::process::{Command as ProcessCommand, Stdio};
use std::time::Duration;

use anyhow::Result;
use poneglyph_core::Workspace;

use poneglyph_api::proto::{ShutdownRequest, StatusRequest};

use crate::client::daemon_client;
use crate::config::PoneglyphDaemonConfig;

pub async fn status(config: PoneglyphDaemonConfig, json: bool) -> Result<()> {
    match daemon_client(&config).await {
        Ok(mut client) => {
            let status = client.status(StatusRequest {}).await?.into_inner();
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": status.status,
                        "workspace": status.workspace,
                        "uptime_seconds": status.uptime_seconds,
                    }))?
                );
            } else {
                println!("status: {}", status.status);
                println!("workspace: {}", status.workspace);
                println!("uptime_seconds: {}", status.uptime_seconds);
            }
            Ok(())
        }
        Err(error) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": "offline",
                        "error": error.to_string(),
                    }))?
                );
            } else {
                println!("status: offline");
                println!("error: {error}");
            }
            Ok(())
        }
    }
}

pub async fn stop(config: PoneglyphDaemonConfig, json: bool) -> Result<()> {
    let mut client = daemon_client(&config).await?;
    let response = client.shutdown(ShutdownRequest {}).await?.into_inner();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": response.status,
            }))?
        );
    } else {
        println!("status: {}", response.status);
    }
    Ok(())
}

pub async fn restart(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    json: bool,
) -> Result<()> {
    if daemon_client(&config).await.is_ok() {
        stop(config.clone(), false).await?;
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
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "status": "restarted",
                "rpc_bind_addr": config.rpc.bind_addr.to_string(),
            }))?
        );
    } else {
        println!("status: restarted");
    }
    Ok(())
}

async fn wait_until_offline(config: &PoneglyphDaemonConfig) {
    for _ in 0..40 {
        if daemon_client(config).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_until_running(config: &PoneglyphDaemonConfig) -> Result<()> {
    let mut last_error = None;
    for _ in 0..80 {
        match daemon_client(config).await {
            Ok(mut client) => {
                if client.status(StatusRequest {}).await.is_ok() {
                    return Ok(());
                }
                last_error = Some("status RPC failed".to_string());
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    anyhow::bail!(
        "daemon did not become ready: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )
}
