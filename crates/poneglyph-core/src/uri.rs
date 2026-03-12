use proptest::prelude::*;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::{Error, Result};

/// Validated URI identifier used across the Poneglyph domain model.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Uri(Url);

impl Uri {
    pub fn parse(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        let parsed = Url::parse(&value).map_err(|source| Error::InvalidUri {
            value: value.clone(),
            source,
        })?;
        if parsed.scheme().is_empty() {
            return Err(Error::InvalidUriMissingScheme { value });
        }
        Ok(Self(parsed))
    }

    pub fn from_parts(namespace: &str, kind: &str, id: Option<&str>) -> Result<Self> {
        if namespace.is_empty() || kind.is_empty() {
            return Err(Error::MissingUriParts);
        }

        let id = id
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        Self::parse(format!("{namespace}:{kind}:{id}"))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

#[macro_export]
macro_rules! uri {
    ($value:expr) => {{ $crate::Uri::parse($value).expect("invalid uri") }};
    ($namespace:expr, $kind:expr) => {{ $crate::Uri::from_parts($namespace, $kind, None).expect("invalid uri parts") }};
    ($namespace:expr, $kind:expr, $id:expr) => {{ $crate::Uri::from_parts($namespace, $kind, Some($id)).expect("invalid uri parts") }};
}

impl std::fmt::Display for Uri {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl Arbitrary for Uri {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            "[a-z][a-z0-9]{0,10}",
            "[a-z][a-z0-9]{0,10}",
            "[a-z0-9][a-z0-9]{0,15}",
        )
            .prop_map(|(namespace, kind, id)| {
                Uri::parse(format!("pg:{namespace}:{kind}:{id}")).expect("generated uri")
            })
            .boxed()
    }
}
