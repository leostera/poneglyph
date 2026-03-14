use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct PlexMediaContainer {
    #[serde(rename = "MediaContainer")]
    pub(super) media_container: PlexLibrarySections,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct PlexLibrarySections {
    #[serde(rename = "Directory")]
    pub(super) directory: Option<Vec<PlexLibrarySection>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct PlexLibrarySection {
    pub(super) key: String,
    pub(super) title: String,
    #[serde(rename = "type")]
    pub(super) section_type: String,
    #[serde(rename = "Location", default)]
    pub(super) locations: Vec<PlexLocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct PlexLocation {
    pub(super) path: String,
}
