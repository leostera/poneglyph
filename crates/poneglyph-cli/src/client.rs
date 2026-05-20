use anyhow::Result;
use poneglyph::{Poneglyph, Workspace};

use poneglyph_api::proto::poneglyph_daemon_client::PoneglyphDaemonClient;

use crate::config::PoneglyphDaemonConfig;

pub async fn daemon_client(
    config: &PoneglyphDaemonConfig,
) -> Result<PoneglyphDaemonClient<tonic::transport::Channel>, tonic::transport::Error> {
    PoneglyphDaemonClient::connect(format!("http://{}", config.rpc.bind_addr)).await
}

pub async fn open_runtime(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
) -> Result<Poneglyph> {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_config(config.poneglyph)
        .build()
        .await
        .map_err(Into::into)
}
