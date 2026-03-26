use chrono::{DateTime, Utc};
use poneglyph_ctl::SavePlexConnection;
use serde::Deserialize;

use crate::context::AppContext;

#[derive(Debug, Clone)]
pub(crate) struct PlexConnection {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub libraries: Vec<String>,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlexDetection {
    pub base_url: String,
    pub token: Option<String>,
    pub machine_identifier: Option<String>,
    pub libraries: Vec<String>,
}

pub(crate) struct PlexService<'a> {
    context: &'a AppContext,
}

impl<'a> PlexService<'a> {
    pub(crate) fn new(context: &'a AppContext) -> Self {
        Self { context }
    }

    pub(crate) async fn list_connections(
        &self,
    ) -> std::result::Result<Vec<PlexConnection>, String> {
        let connections = self
            .context
            .ctl
            .list_plex_connections()
            .await
            .map_err(|error| format!("failed to list plex connections: {error}"))?;

        let mut result = Vec::with_capacity(connections.len());
        for connection in connections {
            let mut last_synced_at = None;
            let mut last_error = None;
            for library in &connection.libraries {
                let scoped_key = format!("store-{}:{library}", connection.id);
                let sync_state = self
                    .context
                    .ctl
                    .plex_library_sync_state(scoped_key.as_str())
                    .await
                    .map_err(|error| format!("failed to load plex sync state: {error}"))?;
                if let Some(sync_state) = sync_state {
                    update_latest_sync(
                        &mut last_synced_at,
                        &mut last_error,
                        sync_state.last_synced_at,
                        sync_state.last_error,
                    );
                }
            }
            result.push(PlexConnection {
                id: connection.id,
                name: connection.name,
                base_url: connection.base_url,
                libraries: connection.libraries,
                last_synced_at,
                last_error,
            });
        }

        Ok(result)
    }

    pub(crate) async fn save_connection(
        &self,
        name: String,
        base_url: String,
        token: String,
        libraries: Vec<String>,
    ) -> std::result::Result<PlexConnection, String> {
        let discovered = discover_plex_server(base_url.as_str(), token.as_str()).await?;
        let saved = self
            .context
            .ctl
            .save_plex_connection(SavePlexConnection {
                name,
                machine_identifier: discovered.machine_identifier,
                base_url,
                token,
                libraries,
            })
            .await
            .map_err(|error| format!("failed to save plex connection: {error}"))?;

        Ok(PlexConnection {
            id: saved.id,
            name: saved.name,
            base_url: saved.base_url,
            libraries: saved.libraries,
            last_synced_at: None,
            last_error: None,
        })
    }

    pub(crate) async fn delete_connection(
        &self,
        connection_id: i64,
    ) -> std::result::Result<bool, String> {
        self.context
            .ctl
            .delete_plex_connection(connection_id)
            .await
            .map_err(|error| format!("failed to delete plex connection: {error}"))
    }
}

pub(crate) async fn discover_libraries(
    base_url: &str,
    token: &str,
) -> std::result::Result<Vec<String>, String> {
    fetch_library_sections(base_url, token)
        .await
        .map(|sections| extract_libraries(&sections))
}

pub(crate) async fn detect_local_connection() -> PlexDetection {
    let base_url = "http://127.0.0.1:32400".to_string();
    let token = std::env::var("PONEGLYPH_PLEX_TOKEN")
        .ok()
        .or_else(read_plex_token_from_preferences);

    let mut machine_identifier = None;
    let mut libraries = Vec::new();

    if let Some(token_value) = token.as_deref() {
        if let Ok(sections) = fetch_library_sections(base_url.as_str(), token_value).await {
            machine_identifier = sections.machine_identifier.clone();
            libraries = extract_libraries(&sections);
        }
    }

    PlexDetection {
        base_url,
        token,
        machine_identifier,
        libraries,
    }
}

fn read_plex_token_from_preferences() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let candidates = [
        format!("{home}/Library/Application Support/Plex Media Server/Preferences.xml"),
        format!("{home}/.config/plexmediaserver/Preferences.xml"),
        format!("{home}/.local/share/plexmediaserver/Preferences.xml"),
    ];

    for path in candidates {
        let xml = match std::fs::read_to_string(path) {
            Ok(xml) => xml,
            Err(_) => continue,
        };
        if let Some(token) = extract_xml_attribute(&xml, "PlexOnlineToken") {
            return Some(token);
        }
    }

    None
}

fn extract_xml_attribute(xml: &str, attribute: &str) -> Option<String> {
    let needle = format!(r#"{attribute}=""#);
    let start = xml.find(needle.as_str())?;
    let token_start = start + needle.len();
    let rest = &xml[token_start..];
    let token_end = rest.find('"')?;
    Some(rest[..token_end].to_string())
}

#[derive(Debug, Deserialize)]
struct PlexLibrarySections {
    #[serde(rename = "machineIdentifier")]
    machine_identifier: Option<String>,
    #[serde(rename = "Directory")]
    directory: Option<Vec<PlexLibrarySection>>,
}

#[derive(Debug, Deserialize)]
struct PlexLibrarySection {
    title: String,
}

#[derive(Debug, Deserialize)]
struct PlexMediaContainer {
    #[serde(rename = "MediaContainer")]
    media_container: PlexLibrarySections,
}

#[derive(Debug, Clone)]
struct DiscoveredPlexServer {
    machine_identifier: String,
}

async fn discover_plex_server(
    base_url: &str,
    token: &str,
) -> std::result::Result<DiscoveredPlexServer, String> {
    let sections = fetch_library_sections(base_url, token).await?;
    let machine_identifier = sections
        .machine_identifier
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "plex server discovery did not include a machineIdentifier; cannot save connection"
                .to_string()
        })?;

    Ok(DiscoveredPlexServer { machine_identifier })
}

async fn fetch_library_sections(
    base_url: &str,
    token: &str,
) -> std::result::Result<PlexLibrarySections, String> {
    let response = reqwest::Client::new()
        .get(format!(
            "{}/library/sections/all",
            base_url.trim_end_matches('/')
        ))
        .query(&[("X-Plex-Token", token)])
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("failed to request plex libraries: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "plex library discovery failed with status {}",
            response.status()
        ));
    }

    let payload: PlexMediaContainer = response
        .json()
        .await
        .map_err(|error| format!("failed to decode plex libraries response: {error}"))?;

    Ok(payload.media_container)
}

fn extract_libraries(sections: &PlexLibrarySections) -> Vec<String> {
    let mut libraries: Vec<String> = sections
        .directory
        .as_ref()
        .map(|values| values.iter().map(|section| section.title.clone()).collect())
        .unwrap_or_default();
    libraries.sort();
    libraries.dedup();
    libraries
}

fn update_latest_sync(
    last_synced_at: &mut Option<DateTime<Utc>>,
    last_error: &mut Option<String>,
    candidate_synced_at: Option<DateTime<Utc>>,
    candidate_error: Option<String>,
) {
    if let Some(candidate_synced_at) = candidate_synced_at {
        match last_synced_at {
            Some(current) if *current >= candidate_synced_at => {}
            _ => *last_synced_at = Some(candidate_synced_at),
        }
    }

    if last_error.is_none() && candidate_error.is_some() {
        *last_error = candidate_error;
    }
}
