use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleCalendarResource {
    pub calendar_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub primary: bool,
    pub selected: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CalendarListResponse {
    #[serde(default)]
    pub items: Vec<CalendarListEntry>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CalendarListEntry {
    pub id: String,
    pub summary: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "timeZone")]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleCalendarEvent {
    pub event_id: String,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub html_link: Option<String>,
    pub start: Option<GoogleCalendarTime>,
    pub end: Option<GoogleCalendarTime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleCalendarEventSync {
    pub events: Vec<GoogleCalendarEvent>,
    pub next_sync_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoogleCalendarTime {
    Date(NaiveDate),
    DateTime(DateTime<Utc>),
}

#[derive(Debug, Deserialize)]
pub(crate) struct EventListResponse {
    #[serde(default)]
    pub items: Vec<EventListEntry>,
    #[serde(rename = "nextSyncToken")]
    pub next_sync_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct EventListEntry {
    pub id: String,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "htmlLink")]
    pub html_link: Option<String>,
    pub start: Option<EventDateTime>,
    pub end: Option<EventDateTime>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct EventDateTime {
    pub date: Option<String>,
    #[serde(rename = "dateTime")]
    pub date_time: Option<String>,
}

impl GoogleCalendarTime {
    pub fn parse(value: &EventDateTime) -> Option<Self> {
        if let Some(date_time) = &value.date_time {
            return DateTime::parse_from_rfc3339(date_time)
                .ok()
                .map(|value| Self::DateTime(value.with_timezone(&Utc)));
        }
        if let Some(date) = &value.date {
            return NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()
                .map(Self::Date);
        }
        None
    }
}
