use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid uri `{value}`: {source}")]
    InvalidUri {
        value: String,
        #[source]
        source: url::ParseError,
    },
    #[error("invalid uri `{value}`: missing scheme")]
    InvalidUriMissingScheme { value: String },
    #[error("namespace and kind must be present")]
    MissingUriParts,
    #[error("fact builder requires a source")]
    MissingFactSource,
    #[error("fact builder requires an entity")]
    MissingFactEntity,
    #[error("fact builder requires a field")]
    MissingFactField,
    #[error("fact builder requires a value")]
    MissingFactValue,
}

pub type Result<T> = std::result::Result<T, Error>;
