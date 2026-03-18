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
