use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CtlError {
    #[error("plex connector requires a base_url")]
    MissingPlexBaseUrl,
}

pub type CtlResult<T> = std::result::Result<T, CtlError>;
