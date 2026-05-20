use proptest::prelude::*;
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::error::{Error, PoneResult};

const BASE62: &[u8; 62] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

fn uuid_to_base62(uuid: Uuid) -> String {
    let mut value = u128::from_be_bytes(*uuid.as_bytes());

    let mut out = Vec::new();

    if value == 0 {
        out.push(BASE62[0] as char);
    } else {
        while value > 0 {
            let rem = (value % 62) as usize;
            out.push(BASE62[rem] as char);
            value /= 62;
        }
        out.reverse();
    }

    let s: String = out.into_iter().collect();

    if s.len() < 22 {
        format!("{:0>22}", s)
    } else {
        s
    }
}

/// Validated URI identifier used across the Poneglyph domain model.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Uri(Url);

impl Uri {
    pub fn parse(value: impl Into<String>) -> PoneResult<Self> {
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

    pub fn from_parts(namespace: &str, kind: &str, id: Option<&str>) -> PoneResult<Self> {
        if namespace.is_empty() || kind.is_empty() {
            return Err(Error::MissingUriParts);
        }

        let id = id
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| uuid_to_base62(Uuid::now_v7()));
        Self::parse(format!("{namespace}:{kind}:{id}"))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn namespace(&self) -> &str {
        self.0.scheme()
    }

    pub fn kind(&self) -> PoneResult<&str> {
        self.0
            .path()
            .split(':')
            .next()
            .filter(|segment| !segment.is_empty())
            .ok_or_else(|| Error::MissingUriKind {
                value: self.to_string(),
            })
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

impl PartialOrd for Uri {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Uri {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.as_str().cmp(other.as_str())
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
