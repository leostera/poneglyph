use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("home directory is unavailable")]
    HomeDirectoryUnavailable,
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
    #[error("uri `{value}` is missing a kind segment")]
    MissingUriKind { value: String },
    #[error("fact builder requires a source")]
    MissingFactSource,
    #[error("fact builder requires an entity")]
    MissingFactEntity,
    #[error("fact builder requires a field")]
    MissingFactField,
    #[error("fact builder requires a value")]
    MissingFactValue,
    #[error("fact service builder requires a store")]
    MissingFactServiceStore,
    #[error("consolidator builder requires an entity store")]
    MissingConsolidatorEntityStore,
    #[error("consolidator builder requires a fact subscription")]
    MissingConsolidatorFactSubscription,
    #[error("projection runner builder requires an entity subscription")]
    MissingProjectionRunnerEntitySubscription,
    #[error("projection runner builder requires at least one projection")]
    MissingProjectionRunnerProjection,
    #[error("workspace io error")]
    WorkspaceIo {
        #[source]
        source: std::io::Error,
    },
    #[error("config io error")]
    ConfigIo {
        #[source]
        source: std::io::Error,
    },
    #[error("config parse error")]
    ConfigTomlDeserialize {
        #[source]
        source: toml::de::Error,
    },
    #[error("config serialize error")]
    ConfigTomlSerialize {
        #[source]
        source: toml::ser::Error,
    },
    #[error("search projection io error")]
    SearchProjectionIo {
        #[source]
        source: std::io::Error,
    },
    #[error("search projection document is missing entity_uri")]
    MissingSearchProjectionEntityUri,
    #[error("state_facts requires at least one fact")]
    EmptyFactBatch,
    #[error("pending facts cannot carry a tx_id")]
    PendingFactHasTxId,
    #[error("cannot retract unknown fact")]
    CannotRetractUnknownFact,
    #[error("fact store io error")]
    FactStoreIo {
        #[source]
        source: std::io::Error,
    },
    #[error("entity store io error")]
    EntityStoreIo {
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Datafox(#[from] datafox::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    SerdeJson(#[from] serde_json::Error),
    #[error(transparent)]
    Tantivy(#[from] tantivy::TantivyError),
    #[error(transparent)]
    TantivyQueryParser(#[from] tantivy::query::QueryParserError),
}

pub type PoneResult<T> = std::result::Result<T, Error>;
