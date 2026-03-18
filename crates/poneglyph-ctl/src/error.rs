use thiserror::Error;

#[derive(Debug, Error)]
pub enum CtlError {
    #[error("control store I/O failed: {0}")]
    StoreIo(String),
    #[error("control store migration failed: {0}")]
    StoreMigration(String),
    #[error("control store query failed: {0}")]
    StoreQuery(String),
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
    #[error("gcal connector requires an oauth connection")]
    MissingGoogleOAuthConnection,
    #[error("gcal request failed: {0}")]
    GcalRequest(String),
    #[error("gcal returned unexpected status: {0}")]
    GcalUnexpectedStatus(u16),
    #[error("gcal sync token expired")]
    GcalSyncTokenExpired,
    #[error("gcal response decode failed: {0}")]
    GcalResponseDecode(String),
    #[error("connector task join failed: {0}")]
    ConnectorTaskJoin(String),
}

pub type CtlResult<T> = std::result::Result<T, CtlError>;
