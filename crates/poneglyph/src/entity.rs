use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{Uri, Value};

/// Deterministic materialized view of one entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    pub uri: Uri,
    pub namespace: String,
    pub kind: String,
    pub fields: BTreeMap<Uri, Value>,
}
