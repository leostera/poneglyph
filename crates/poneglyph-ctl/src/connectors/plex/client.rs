use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use reqwest::{Client, StatusCode, Url};

use crate::{CtlError, CtlResult};

use super::connector::PlexConfig;
use super::types::{PlexLibrarySection, PlexMediaContainer, PlexMetadataItem};

#[derive(Debug, Clone)]
pub(super) struct PlexClient {
    base_url: Option<Url>,
    token: Option<String>,
    http: Client,
}

impl PlexClient {
    pub(super) fn new(config: &PlexConfig) -> CtlResult<Self> {
        let base_url = match &config.base_url {
            Some(base_url) => Some(
                Url::parse(base_url)
                    .map_err(|_| CtlError::InvalidPlexBaseUrl(base_url.to_string()))?,
            ),
            None => None,
        };

        if config.enabled && config.token.is_none() {
            return Err(CtlError::MissingPlexToken);
        }

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let http = Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|_| {
                CtlError::InvalidPlexBaseUrl(
                    base_url
                        .as_ref()
                        .map(Url::to_string)
                        .unwrap_or_else(|| "missing".to_string()),
                )
            })?;

        Ok(Self {
            base_url,
            token: config.token.clone(),
            http,
        })
    }

    pub(super) fn base_url(&self) -> Option<&Url> {
        self.base_url.as_ref()
    }

    pub(super) fn library_sections_url(&self) -> CtlResult<Url> {
        let mut url = self.base_url.clone().ok_or(CtlError::MissingPlexBaseUrl)?;
        url.set_path("/library/sections/all");
        if let Some(token) = &self.token {
            url.query_pairs_mut().append_pair("X-Plex-Token", token);
        }
        Ok(url)
    }

    pub(super) fn redacted_library_sections_url(&self) -> CtlResult<String> {
        let mut url = self.base_url.clone().ok_or(CtlError::MissingPlexBaseUrl)?;
        url.set_path("/library/sections/all");
        if self.token.is_some() {
            url.query_pairs_mut()
                .append_pair("X-Plex-Token", "<redacted>");
        }
        Ok(url.to_string())
    }

    pub(super) fn library_items_url(&self, section_key: &str) -> CtlResult<Url> {
        let mut url = self.base_url.clone().ok_or(CtlError::MissingPlexBaseUrl)?;
        url.set_path(&format!("/library/sections/{section_key}/all"));
        if let Some(token) = &self.token {
            url.query_pairs_mut().append_pair("X-Plex-Token", token);
        }
        Ok(url)
    }

    pub(super) async fn fetch_library_sections(&self) -> CtlResult<Vec<PlexLibrarySection>> {
        let url = self.library_sections_url()?;
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| CtlError::PlexRequest(error.to_string()))?;

        if response.status() != StatusCode::OK {
            return Err(CtlError::PlexUnexpectedStatus(response.status().as_u16()));
        }

        let payload: PlexMediaContainer = response
            .json()
            .await
            .map_err(|error| CtlError::PlexResponseDecode(error.to_string()))?;
        Ok(payload.media_container.directory.unwrap_or_default())
    }

    pub(super) async fn fetch_library_items(
        &self,
        section_key: &str,
    ) -> CtlResult<Vec<PlexMetadataItem>> {
        let url = self.library_items_url(section_key)?;
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| CtlError::PlexRequest(error.to_string()))?;

        if response.status() != StatusCode::OK {
            return Err(CtlError::PlexUnexpectedStatus(response.status().as_u16()));
        }

        let payload: PlexMediaContainer = response
            .json()
            .await
            .map_err(|error| CtlError::PlexResponseDecode(error.to_string()))?;
        Ok(payload.media_container.metadata.unwrap_or_default())
    }
}
