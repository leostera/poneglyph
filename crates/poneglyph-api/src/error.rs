use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("api server builder requires a poneglyph runtime")]
    MissingServerPoneglyph,
    #[error("api bind address is invalid")]
    BindAddress(#[from] std::net::AddrParseError),
    #[error("api io error")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
