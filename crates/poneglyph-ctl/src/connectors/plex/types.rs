use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct PlexMediaContainer {
    #[serde(rename = "MediaContainer")]
    pub(super) media_container: PlexLibrarySections,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct PlexLibrarySections {
    #[serde(rename = "Directory")]
    pub(super) directory: Option<Vec<PlexLibrarySection>>,
    #[serde(rename = "Metadata")]
    pub(super) metadata: Option<Vec<PlexMetadataItem>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct PlexLibrarySection {
    pub(super) key: String,
    pub(super) title: String,
    #[serde(rename = "type")]
    pub(super) section_type: String,
    #[serde(rename = "Location", default)]
    pub(super) locations: Vec<PlexLocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct PlexLocation {
    pub(super) path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct PlexMetadataItem {
    #[serde(rename = "ratingKey")]
    pub(super) rating_key: String,
    pub(super) key: Option<String>,
    pub(super) guid: Option<String>,
    #[serde(rename = "type")]
    pub(super) item_type: String,
    pub(super) title: String,
    pub(super) summary: Option<String>,
    pub(super) year: Option<i64>,
    #[serde(rename = "addedAt")]
    pub(super) added_at: Option<i64>,
    #[serde(rename = "updatedAt")]
    pub(super) updated_at: Option<i64>,
}
