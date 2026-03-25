use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailProfile {
    pub email_address: String,
    pub history_id: Option<String>,
    pub messages_total: i64,
    pub threads_total: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailLabel {
    pub id: String,
    pub name: String,
    pub label_type: Option<String>,
    pub message_list_visibility: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailMessage {
    pub id: String,
    pub thread_id: String,
    pub history_id: Option<String>,
    pub internal_date: Option<DateTime<Utc>>,
    pub snippet: Option<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailProfileResponse {
    #[serde(rename = "emailAddress")]
    pub email_address: String,
    #[serde(rename = "historyId")]
    pub history_id: Option<String>,
    #[serde(rename = "messagesTotal")]
    pub messages_total: i64,
    #[serde(rename = "threadsTotal")]
    pub threads_total: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailLabelListResponse {
    #[serde(default)]
    pub labels: Vec<GmailLabelEntry>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailLabelEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub label_type: Option<String>,
    #[serde(rename = "messageListVisibility")]
    pub message_list_visibility: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailMessageListResponse {
    #[serde(default)]
    pub messages: Vec<GmailMessageListEntry>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailMessageListEntry {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailMessageMetadataResponse {
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "historyId")]
    pub history_id: Option<String>,
    #[serde(rename = "internalDate")]
    pub internal_date: Option<String>,
    pub snippet: Option<String>,
    pub payload: Option<GmailPayload>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailPayload {
    #[serde(default)]
    pub headers: Vec<GmailHeader>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GmailHeader {
    pub name: String,
    pub value: String,
}

impl GmailMessage {
    pub(crate) fn from_metadata(value: GmailMessageMetadataResponse) -> Self {
        let headers = value
            .payload
            .map(|payload| payload.headers)
            .unwrap_or_default();
        let subject = find_header(&headers, "Subject");
        let from = find_header(&headers, "From");
        let to = find_header(&headers, "To");

        Self {
            id: value.id,
            thread_id: value.thread_id,
            history_id: value.history_id,
            internal_date: value
                .internal_date
                .as_deref()
                .and_then(parse_internal_date_millis),
            snippet: value.snippet,
            subject,
            from,
            to,
        }
    }
}

fn find_header(headers: &[GmailHeader], header_name: &str) -> Option<String> {
    headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(header_name))
        .map(|header| header.value.clone())
}

fn parse_internal_date_millis(value: &str) -> Option<DateTime<Utc>> {
    let millis: i64 = value.parse().ok()?;
    Utc.timestamp_millis_opt(millis).single()
}
