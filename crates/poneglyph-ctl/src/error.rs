use thiserror::Error;

#[derive(Debug, Error)]
pub enum CtlError {
    #[error("plex connector requires a base_url")]
    MissingPlexBaseUrl,
    #[error("plex connector requires a token")]
    MissingPlexToken,
    #[error("plex connector has an invalid base_url: {0}")]
    InvalidPlexBaseUrl(String),
    #[error("plex connector is disabled")]
    ConnectorDisabled,
    #[error("plex request failed: {0}")]
    PlexRequest(String),
    #[error("plex returned unexpected status: {0}")]
    PlexUnexpectedStatus(u16),
    #[error("plex response decode failed: {0}")]
    PlexResponseDecode(String),
}

pub type CtlResult<T> = std::result::Result<T, CtlError>;
