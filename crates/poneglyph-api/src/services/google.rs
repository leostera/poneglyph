use poneglyph_ctl::{CtlStore, GcalConnector, GoogleOAuthConnection};

use crate::context::AppContext;

#[derive(Debug, Clone)]
pub(crate) struct GoogleCalendarResource {
    pub calendar_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub primary: bool,
    pub selected: bool,
}

pub(crate) async fn discover_calendars(
    context: &AppContext,
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    let connector = GcalConnector::init(Default::default())
        .map_err(|error| format!("failed to initialize gcal connector: {error}"))?;

    connector
        .discover_calendars(&context.ctl)
        .await
        .map(|calendars| calendars.into_iter().map(map_connector_calendar).collect())
        .map_err(|error| format!("failed to discover google calendars: {error}"))
}

pub(crate) async fn list_calendars(
    context: &AppContext,
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    let connection = latest_google_connection(&context.ctl).await?;
    context
        .ctl
        .list_google_calendar_resources(connection.id)
        .await
        .map(|calendars| {
            calendars
                .into_iter()
                .map(|calendar| GoogleCalendarResource {
                    calendar_id: calendar.calendar_id,
                    summary: calendar.summary,
                    description: calendar.description,
                    time_zone: calendar.time_zone,
                    primary: calendar.primary,
                    selected: calendar.selected,
                })
                .collect()
        })
        .map_err(|error| format!("failed to list google calendars: {error}"))
}

pub(crate) async fn select_calendars(
    context: &AppContext,
    calendar_ids: &[String],
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    let connection = latest_google_connection(&context.ctl).await?;
    context
        .ctl
        .set_google_calendar_selection(connection.id, calendar_ids)
        .await
        .map(|calendars| {
            calendars
                .into_iter()
                .map(|calendar| GoogleCalendarResource {
                    calendar_id: calendar.calendar_id,
                    summary: calendar.summary,
                    description: calendar.description,
                    time_zone: calendar.time_zone,
                    primary: calendar.primary,
                    selected: calendar.selected,
                })
                .collect()
        })
        .map_err(|error| format!("failed to update google calendar selection: {error}"))
}

async fn latest_google_connection(
    ctl: &CtlStore,
) -> std::result::Result<GoogleOAuthConnection, String> {
    match ctl.latest_google_oauth_connection().await {
        Ok(Some(connection)) => Ok(connection),
        Ok(None) => Err("no google oauth connection found".to_string()),
        Err(error) => Err(format!("failed to load google oauth connection: {error}")),
    }
}

fn map_connector_calendar(
    calendar: poneglyph_ctl::GoogleCalendarResource,
) -> GoogleCalendarResource {
    GoogleCalendarResource {
        calendar_id: calendar.calendar_id,
        summary: calendar.summary,
        description: calendar.description,
        time_zone: calendar.time_zone,
        primary: calendar.primary,
        selected: false,
    }
}
