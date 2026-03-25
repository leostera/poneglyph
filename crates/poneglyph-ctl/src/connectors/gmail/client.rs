use reqwest::Client;

use crate::{CtlError, CtlResult};

use super::types::{
    GmailLabel, GmailLabelListResponse, GmailMessage, GmailMessageListResponse,
    GmailMessageMetadataResponse, GmailProfile, GmailProfileResponse, GmailSendAsAddress,
    GmailSendAsListResponse,
};

#[derive(Debug, Clone)]
pub struct GmailClient {
    http: Client,
    base_url: String,
}

impl Default for GmailClient {
    fn default() -> Self {
        Self {
            http: Client::new(),
            base_url: std::env::var("PONEGLYPH_GMAIL_API_BASE_URL")
                .unwrap_or_else(|_| "https://gmail.googleapis.com".to_string()),
        }
    }
}

impl GmailClient {
    pub async fn profile(&self, access_token: &str) -> CtlResult<GmailProfile> {
        let payload: GmailProfileResponse = self
            .http
            .get(format!(
                "{}/gmail/v1/users/me/profile",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CtlError::GmailRequest(error.to_string()))?
            .error_for_status()
            .map_err(|error| CtlError::GmailUnexpectedStatus(status_code_or_zero(&error)))?
            .json()
            .await
            .map_err(|error| CtlError::GmailResponseDecode(error.to_string()))?;

        Ok(GmailProfile {
            email_address: payload.email_address,
            history_id: payload.history_id,
            messages_total: payload.messages_total,
            threads_total: payload.threads_total,
        })
    }

    pub async fn list_labels(&self, access_token: &str) -> CtlResult<Vec<GmailLabel>> {
        let payload: GmailLabelListResponse = self
            .http
            .get(format!(
                "{}/gmail/v1/users/me/labels",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CtlError::GmailRequest(error.to_string()))?
            .error_for_status()
            .map_err(|error| CtlError::GmailUnexpectedStatus(status_code_or_zero(&error)))?
            .json()
            .await
            .map_err(|error| CtlError::GmailResponseDecode(error.to_string()))?;

        Ok(payload
            .labels
            .into_iter()
            .map(|label| GmailLabel {
                id: label.id,
                name: label.name,
                label_type: label.label_type,
                message_list_visibility: label.message_list_visibility,
            })
            .collect())
    }

    pub async fn list_send_as_addresses(
        &self,
        access_token: &str,
    ) -> CtlResult<Vec<GmailSendAsAddress>> {
        let payload: GmailSendAsListResponse = self
            .http
            .get(format!(
                "{}/gmail/v1/users/me/settings/sendAs",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CtlError::GmailRequest(error.to_string()))?
            .error_for_status()
            .map_err(|error| CtlError::GmailUnexpectedStatus(status_code_or_zero(&error)))?
            .json()
            .await
            .map_err(|error| CtlError::GmailResponseDecode(error.to_string()))?;

        Ok(payload
            .send_as
            .into_iter()
            .map(|entry| GmailSendAsAddress {
                send_as_email: entry.send_as_email,
            })
            .collect())
    }

    pub async fn list_messages(
        &self,
        access_token: &str,
        max_results: usize,
    ) -> CtlResult<Vec<GmailMessage>> {
        let payload: GmailMessageListResponse = self
            .http
            .get(format!(
                "{}/gmail/v1/users/me/messages",
                self.base_url.trim_end_matches('/')
            ))
            .query(&[("maxResults", max_results.to_string())])
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CtlError::GmailRequest(error.to_string()))?
            .error_for_status()
            .map_err(|error| CtlError::GmailUnexpectedStatus(status_code_or_zero(&error)))?
            .json()
            .await
            .map_err(|error| CtlError::GmailResponseDecode(error.to_string()))?;

        let mut messages = Vec::with_capacity(payload.messages.len());
        for message in payload.messages {
            let detail: GmailMessageMetadataResponse = self
                .http
                .get(format!(
                    "{}/gmail/v1/users/me/messages/{}",
                    self.base_url.trim_end_matches('/'),
                    message.id
                ))
                .query(&[
                    ("format", "metadata".to_string()),
                    ("metadataHeaders", "Subject".to_string()),
                    ("metadataHeaders", "From".to_string()),
                    ("metadataHeaders", "To".to_string()),
                ])
                .bearer_auth(access_token)
                .send()
                .await
                .map_err(|error| CtlError::GmailRequest(error.to_string()))?
                .error_for_status()
                .map_err(|error| CtlError::GmailUnexpectedStatus(status_code_or_zero(&error)))?
                .json()
                .await
                .map_err(|error| CtlError::GmailResponseDecode(error.to_string()))?;

            messages.push(GmailMessage::from_metadata(detail));
        }

        Ok(messages)
    }
}

fn status_code_or_zero(error: &reqwest::Error) -> u16 {
    error.status().map(|status| status.as_u16()).unwrap_or(0)
}
