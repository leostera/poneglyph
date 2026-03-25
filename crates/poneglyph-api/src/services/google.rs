use chrono::{DateTime, Utc};
use poneglyph_ctl::{CtlStore, GcalConnector, GoogleOAuthConnection, PlexConnector};
use tokio::sync::mpsc;

use crate::context::AppContext;

#[derive(Debug, Clone)]
pub(crate) struct GoogleCalendarResource {
    pub connection_id: i64,
    pub calendar_id: String,
    pub summary: String,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub primary: bool,
    pub selected: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct GoogleCalendarConnection {
    pub id: i64,
    pub label: String,
    pub selected_resource_count: i32,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub calendars: Vec<GoogleCalendarResource>,
}

#[derive(Debug, Clone)]
pub(crate) struct ConnectorStatus {
    pub name: String,
    pub enabled: bool,
    pub connected: bool,
    pub selected_resource_count: i32,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ConnectorSyncResult {
    pub name: String,
    pub synced: bool,
    pub message: String,
}

pub(crate) async fn discover_calendars(
    context: &AppContext,
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    let connection = latest_google_connection(&context.ctl).await?;
    discover_calendars_for_connection(context, connection.id).await
}

pub(crate) async fn discover_calendars_for_connection(
    context: &AppContext,
    connection_id: i64,
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    let connector = GcalConnector::init(Default::default())
        .map_err(|error| format!("failed to initialize gcal connector: {error}"))?;

    connector
        .discover_calendars_for_connection_id(&context.ctl, connection_id)
        .await
        .map(|calendars| {
            calendars
                .into_iter()
                .map(|calendar| map_connector_calendar(connection_id, calendar))
                .collect()
        })
        .map_err(|error| format!("failed to discover google calendars: {error}"))
}

pub(crate) async fn list_calendars(
    context: &AppContext,
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    let connection = latest_google_connection(&context.ctl).await?;
    list_calendars_for_connection(context, connection.id).await
}

pub(crate) async fn list_calendars_for_connection(
    context: &AppContext,
    connection_id: i64,
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    context
        .ctl
        .list_google_calendar_resources(connection_id)
        .await
        .map(|calendars| {
            calendars
                .into_iter()
                .map(|calendar| GoogleCalendarResource {
                    connection_id: calendar.connection_id,
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
    select_calendars_for_connection(context, connection.id, calendar_ids).await
}

pub(crate) async fn select_calendars_for_connection(
    context: &AppContext,
    connection_id: i64,
    calendar_ids: &[String],
) -> std::result::Result<Vec<GoogleCalendarResource>, String> {
    context
        .ctl
        .set_google_calendar_selection(connection_id, calendar_ids)
        .await
        .map(|calendars| {
            calendars
                .into_iter()
                .map(|calendar| GoogleCalendarResource {
                    connection_id: calendar.connection_id,
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

pub(crate) async fn list_google_connections(
    context: &AppContext,
) -> std::result::Result<Vec<GoogleCalendarConnection>, String> {
    let connections = context
        .ctl
        .list_google_oauth_connections()
        .await
        .map_err(|error| format!("failed to list google oauth connections: {error}"))?;

    let mut result = Vec::with_capacity(connections.len());
    for connection in connections {
        let calendars = list_calendars_for_connection(context, connection.id).await?;
        let mut selected_resource_count = 0;
        let mut last_synced_at = None;
        let mut last_error = None;

        for calendar in calendars.iter().filter(|calendar| calendar.selected) {
            selected_resource_count += 1;
            let sync_state = context
                .ctl
                .google_calendar_sync_state(connection.id, &calendar.calendar_id)
                .await
                .map_err(|error| format!("failed to load google calendar sync state: {error}"))?;
            if let Some(sync_state) = sync_state {
                update_latest_sync(
                    &mut last_synced_at,
                    &mut last_error,
                    sync_state.last_synced_at,
                    sync_state.last_error,
                );
            }
        }

        result.push(GoogleCalendarConnection {
            id: connection.id,
            label: connection_label(connection.id, &calendars),
            selected_resource_count,
            last_synced_at,
            last_error,
            calendars,
        });
    }

    Ok(result)
}

pub(crate) async fn delete_google_connection(
    context: &AppContext,
    connection_id: i64,
) -> std::result::Result<bool, String> {
    context
        .ctl
        .delete_google_oauth_connection(connection_id)
        .await
        .map_err(|error| format!("failed to delete google oauth connection: {error}"))
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

pub(crate) async fn connector_statuses(
    context: &AppContext,
) -> std::result::Result<Vec<ConnectorStatus>, String> {
    let mut statuses = Vec::new();

    if let Some(config) = context.ctl_config.gcal.as_ref() {
        let connections = context
            .ctl
            .list_google_oauth_connections()
            .await
            .map_err(|error| format!("failed to load google oauth connections: {error}"))?;
        let connected = !connections.is_empty();
        let mut selected_resource_count = 0;
        let mut last_synced_at = None;
        let mut last_error = None;

        for connection in connections {
            let calendars = context
                .ctl
                .list_google_calendar_resources(connection.id)
                .await
                .map_err(|error| format!("failed to list google calendars: {error}"))?;
            for calendar in calendars.into_iter().filter(|calendar| calendar.selected) {
                selected_resource_count += 1;
                let sync_state = context
                    .ctl
                    .google_calendar_sync_state(connection.id, &calendar.calendar_id)
                    .await
                    .map_err(|error| {
                        format!("failed to load google calendar sync state: {error}")
                    })?;
                if let Some(sync_state) = sync_state {
                    update_latest_sync(
                        &mut last_synced_at,
                        &mut last_error,
                        sync_state.last_synced_at,
                        sync_state.last_error,
                    );
                }
            }
        }

        statuses.push(ConnectorStatus {
            name: "gcal".to_string(),
            enabled: config.enabled,
            connected,
            selected_resource_count,
            last_synced_at,
            last_error,
        });
    }

    if let Some(config) = context.ctl_config.plex.as_ref() {
        let stored_connections = context
            .ctl
            .list_plex_connections()
            .await
            .map_err(|error| format!("failed to load plex connections: {error}"))?;
        let has_legacy_connection = config.base_url.is_some() && config.token.is_some();
        let connected = has_legacy_connection || !stored_connections.is_empty();
        let selected_resource_count = if stored_connections.is_empty() {
            config.libraries.len() as i32
        } else {
            stored_connections
                .iter()
                .map(|connection| connection.libraries.len() as i32)
                .sum()
        };

        statuses.push(ConnectorStatus {
            name: "plex".to_string(),
            enabled: config.enabled,
            connected,
            selected_resource_count,
            last_synced_at: None,
            last_error: None,
        });
    }

    Ok(statuses)
}

pub(crate) async fn sync_connector(
    context: &AppContext,
    connector_name: &str,
) -> std::result::Result<ConnectorSyncResult, String> {
    let (tx, mut rx) = mpsc::channel::<Vec<poneglyph::Fact>>(8);
    let bridge_poneglyph = context.poneglyph.clone();
    let bridge = tokio::spawn(async move {
        let mut fact_count = 0usize;
        while let Some(facts) = rx.recv().await {
            fact_count += facts.len();
            bridge_poneglyph
                .state_facts(facts)
                .await
                .map_err(|error| format!("failed to state connector facts: {error}"))?;
        }
        Ok::<usize, String>(fact_count)
    });

    match connector_name {
        "gcal" => {
            let Some(config) = context.ctl_config.gcal.clone() else {
                return Err("gcal connector is not configured".to_string());
            };
            let connector = GcalConnector::init(config)
                .map_err(|error| format!("failed to initialize gcal connector: {error}"))?;
            connector
                .run(context.ctl.clone(), context.poneglyph.clone(), tx)
                .await
                .map_err(|error| format!("gcal sync failed: {error}"))?;
        }
        "plex" => {
            let Some(config) = context.ctl_config.plex.clone() else {
                return Err("plex connector is not configured".to_string());
            };
            let connector = PlexConnector::init(config)
                .map_err(|error| format!("failed to initialize plex connector: {error}"))?;
            connector
                .run(context.ctl.clone(), tx)
                .await
                .map_err(|error| format!("plex sync failed: {error}"))?;
        }
        other => return Err(format!("unknown connector: {other}")),
    }

    let fact_count = bridge
        .await
        .map_err(|error| format!("connector fact bridge task failed: {error}"))??;

    Ok(ConnectorSyncResult {
        name: connector_name.to_string(),
        synced: true,
        message: format!("synced {connector_name} and stated {fact_count} facts"),
    })
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

fn map_connector_calendar(
    connection_id: i64,
    calendar: poneglyph_ctl::GoogleCalendarResource,
) -> GoogleCalendarResource {
    GoogleCalendarResource {
        connection_id,
        calendar_id: calendar.calendar_id,
        summary: calendar.summary,
        description: calendar.description,
        time_zone: calendar.time_zone,
        primary: calendar.primary,
        selected: false,
    }
}

fn connection_label(connection_id: i64, calendars: &[GoogleCalendarResource]) -> String {
    calendars
        .iter()
        .find(|calendar| calendar.primary)
        .or_else(|| calendars.first())
        .map(|calendar| calendar.summary.clone())
        .unwrap_or_else(|| format!("Google account {connection_id}"))
}
