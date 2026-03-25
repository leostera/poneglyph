use chrono::{DateTime, Utc};
use poneglyph::Query;
use poneglyph_ctl::{
    CtlStore, GcalConnector, GmailConnector, GoogleOAuthConnection, PlexConnector,
};
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

#[derive(Debug, Clone)]
pub(crate) struct GmailConnectionSummary {
    pub connection_id: i64,
    pub sending_addresses: Vec<String>,
    pub mailboxes: Vec<String>,
    pub labels: Vec<String>,
    pub emails: Vec<String>,
    pub last_email_received_at: Option<DateTime<Utc>>,
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
    list_google_connections_for_scope(context, "https://www.googleapis.com/auth/calendar.readonly")
        .await
}

pub(crate) async fn list_gmail_connections(
    context: &AppContext,
) -> std::result::Result<Vec<GoogleCalendarConnection>, String> {
    list_google_connections_for_scope(context, "https://www.googleapis.com/auth/gmail.readonly")
        .await
}

async fn list_google_connections_for_scope(
    context: &AppContext,
    required_scope: &str,
) -> std::result::Result<Vec<GoogleCalendarConnection>, String> {
    let connections = context
        .ctl
        .list_google_oauth_connections()
        .await
        .map_err(|error| format!("failed to list google oauth connections: {error}"))?;

    let mut result = Vec::with_capacity(connections.len());
    for connection in connections
        .into_iter()
        .filter(|connection| has_scope(&connection.scopes, required_scope))
    {
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
            label: connection_label(
                connection.id,
                connection.account_email.as_deref(),
                &calendars,
            ),
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

pub(crate) async fn gmail_connection_summary(
    context: &AppContext,
    connection_id: i64,
) -> std::result::Result<GmailConnectionSummary, String> {
    ensure_gmail_bootstrap_snapshot(context, connection_id).await?;
    let connection = load_google_connection(context, connection_id).await?;

    let Some(account_email) = connection.account_email.as_deref() else {
        return Ok(GmailConnectionSummary {
            connection_id,
            sending_addresses: Vec::new(),
            mailboxes: Vec::new(),
            labels: Vec::new(),
            emails: Vec::new(),
            last_email_received_at: None,
        });
    };

    let escaped_email = escape_query_text(account_email);
    let mut sending_addresses = query_unique_strings(
        &context.poneglyph,
        &format!(
            "'schema:type'(Account, \"gmail:account\"), 'gmail:emailAddress'(Account, {escaped_email}), 'gmail:sendAsAddress'(Account, Address)"
        ),
        "Address",
    )
    .await?;
    if sending_addresses.is_empty() {
        sending_addresses.push(account_email.to_string());
    }
    let mailboxes = query_unique_strings(
        &context.poneglyph,
        &format!(
            "'gmail:account'(Label, Account), 'gmail:emailAddress'(Account, {escaped_email}), 'schema:type'(Label, \"gmail:label\"), 'gmail:labelType'(Label, \"system\"), 'schema:name'(Label, Name)"
        ),
        "Name",
    )
    .await?;
    let labels = query_unique_strings(
        &context.poneglyph,
        &format!(
            "'gmail:account'(Label, Account), 'gmail:emailAddress'(Account, {escaped_email}), 'schema:type'(Label, \"gmail:label\"), 'schema:name'(Label, Name)"
        ),
        "Name",
    )
    .await?;
    let emails = query_recent_email_subjects(&context.poneglyph, &escaped_email).await?;
    let last_email_received_at = query_latest_datetime(
        &context.poneglyph,
        &format!(
            "'gmail:account'(Message, Account), 'gmail:emailAddress'(Account, {escaped_email}), 'schema:type'(Message, \"gmail:message\"), 'gmail:internalDate'(Message, InternalDate)"
        ),
        "InternalDate",
    )
    .await?;

    Ok(GmailConnectionSummary {
        connection_id,
        sending_addresses,
        mailboxes,
        labels,
        emails,
        last_email_received_at,
    })
}

async fn ensure_gmail_bootstrap_snapshot(
    context: &AppContext,
    connection_id: i64,
) -> std::result::Result<(), String> {
    let sync_state = context
        .ctl
        .gmail_sync_state(connection_id)
        .await
        .map_err(|error| format!("failed to load gmail sync state: {error}"))?;
    if sync_state.is_some() {
        return Ok(());
    }

    let connector = GmailConnector::init(context.ctl_config.gmail.clone().unwrap_or_default())
        .map_err(|error| format!("failed to initialize gmail connector: {error}"))?;
    connector
        .sync_connection_once(&context.ctl, context.poneglyph.clone(), connection_id)
        .await
        .map_err(|error| format!("failed to bootstrap gmail snapshot: {error}"))?;

    Ok(())
}

async fn load_google_connection(
    context: &AppContext,
    connection_id: i64,
) -> std::result::Result<GoogleOAuthConnection, String> {
    context
        .ctl
        .google_oauth_connection_by_id(connection_id)
        .await
        .map_err(|error| format!("failed to load google oauth connection: {error}"))?
        .ok_or_else(|| format!("google oauth connection not found: {connection_id}"))
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

    let connections = context
        .ctl
        .list_google_oauth_connections()
        .await
        .map_err(|error| format!("failed to load google oauth connections: {error}"))?;
    let connected_gcal = connections.iter().any(|connection| {
        has_scope(
            &connection.scopes,
            "https://www.googleapis.com/auth/calendar.readonly",
        )
    });
    let connected_gmail = connections.iter().any(|connection| {
        has_scope(
            &connection.scopes,
            "https://www.googleapis.com/auth/gmail.readonly",
        )
    });
    let mut selected_resource_count = 0;
    let mut last_synced_at = None;
    let mut last_error = None;

    for connection in &connections {
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
    }

    statuses.push(ConnectorStatus {
        name: "gcal".to_string(),
        enabled: true,
        connected: connected_gcal,
        selected_resource_count,
        last_synced_at,
        last_error,
    });

    statuses.push(ConnectorStatus {
        name: "gmail".to_string(),
        enabled: true,
        connected: connected_gmail,
        selected_resource_count: gmail_message_count(&context.poneglyph).await?,
        last_synced_at: None,
        last_error: None,
    });

    let stored_connections = context
        .ctl
        .list_plex_connections()
        .await
        .map_err(|error| format!("failed to load plex connections: {error}"))?;
    let connected = !stored_connections.is_empty();
    let selected_resource_count = stored_connections
        .iter()
        .map(|connection| connection.libraries.len() as i32)
        .sum();

    statuses.push(ConnectorStatus {
        name: "plex".to_string(),
        enabled: true,
        connected,
        selected_resource_count,
        last_synced_at: None,
        last_error: None,
    });

    Ok(statuses)
}

async fn gmail_message_count(poneglyph: &poneglyph::Poneglyph) -> std::result::Result<i32, String> {
    query_count(poneglyph, "'schema:type'(Entity, \"gmail:message\")").await
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
            let config = context.ctl_config.gcal.clone().unwrap_or_default();
            let connector = GcalConnector::init(config)
                .map_err(|error| format!("failed to initialize gcal connector: {error}"))?;
            connector
                .run(context.ctl.clone(), context.poneglyph.clone(), tx)
                .await
                .map_err(|error| format!("gcal sync failed: {error}"))?;
        }
        "plex" => {
            let config = context.ctl_config.plex.clone().unwrap_or_default();
            let connector = PlexConnector::init(config)
                .map_err(|error| format!("failed to initialize plex connector: {error}"))?;
            connector
                .run(context.ctl.clone(), tx)
                .await
                .map_err(|error| format!("plex sync failed: {error}"))?;
        }
        "gmail" => {
            let config = context.ctl_config.gmail.clone().unwrap_or_default();
            let connector = GmailConnector::init(config)
                .map_err(|error| format!("failed to initialize gmail connector: {error}"))?;
            connector
                .run(context.ctl.clone(), context.poneglyph.clone(), tx)
                .await
                .map_err(|error| format!("gmail sync failed: {error}"))?;
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

fn connection_label(
    connection_id: i64,
    account_email: Option<&str>,
    calendars: &[GoogleCalendarResource],
) -> String {
    calendars
        .iter()
        .find(|calendar| calendar.primary)
        .or_else(|| calendars.first())
        .map(|calendar| calendar.summary.clone())
        .or_else(|| account_email.map(str::to_string))
        .unwrap_or_else(|| format!("Google account {connection_id}"))
}

fn escape_query_text(value: &str) -> String {
    serde_json::to_string(value).expect("valid query string literal")
}

fn has_scope(scopes: &[String], required: &str) -> bool {
    scopes.iter().any(|scope| scope == required)
}

async fn query_count(
    poneglyph: &poneglyph::Poneglyph,
    query: &str,
) -> std::result::Result<i32, String> {
    let parsed =
        Query::parse(query).map_err(|error| format!("failed to parse query `{query}`: {error}"))?;
    let result = poneglyph
        .query(parsed)
        .await
        .map_err(|error| format!("failed to run query `{query}`: {error}"))?;
    let count = result.substitutions().len();
    i32::try_from(count).map_err(|_| "query result count exceeded i32 range".to_string())
}

async fn query_unique_strings(
    poneglyph: &poneglyph::Poneglyph,
    query: &str,
    variable_name: &str,
) -> std::result::Result<Vec<String>, String> {
    let parsed =
        Query::parse(query).map_err(|error| format!("failed to parse query `{query}`: {error}"))?;
    let result = poneglyph
        .query(parsed)
        .await
        .map_err(|error| format!("failed to run query `{query}`: {error}"))?;

    let mut values = std::collections::BTreeSet::new();
    for substitution in result.substitutions() {
        let Some(datafox::Value::String(value)) = substitution.lookup(variable_name) else {
            continue;
        };
        values.insert(value.clone());
    }

    Ok(values.into_iter().collect())
}

async fn query_recent_email_subjects(
    poneglyph: &poneglyph::Poneglyph,
    escaped_email: &str,
) -> std::result::Result<Vec<String>, String> {
    let query = format!(
        "'gmail:account'(Message, Account), 'gmail:emailAddress'(Account, {escaped_email}), 'schema:type'(Message, \"gmail:message\"), 'gmail:messageId'(Message, MessageId), 'gmail:subject'(Message, Subject), 'gmail:internalDate'(Message, InternalDate)"
    );
    let parsed = Query::parse(&query)
        .map_err(|error| format!("failed to parse query `{query}`: {error}"))?;
    let result = poneglyph
        .query(parsed)
        .await
        .map_err(|error| format!("failed to run query `{query}`: {error}"))?;

    let mut rows = Vec::new();
    for substitution in result.substitutions() {
        let Some(datafox::Value::String(message_id)) = substitution.lookup("MessageId") else {
            continue;
        };
        let Some(datafox::Value::String(subject)) = substitution.lookup("Subject") else {
            continue;
        };
        let Some(datafox::Value::String(internal_date_raw)) = substitution.lookup("InternalDate")
        else {
            continue;
        };
        let Ok(internal_date) = DateTime::parse_from_rfc3339(internal_date_raw) else {
            continue;
        };
        rows.push((
            message_id.clone(),
            subject.clone(),
            internal_date.with_timezone(&Utc),
        ));
    }

    rows.sort_by(|left, right| right.2.cmp(&left.2));
    let mut seen = std::collections::BTreeSet::new();
    let mut subjects = Vec::new();
    for (message_id, subject, _) in rows {
        if !seen.insert(message_id) {
            continue;
        }
        subjects.push(subject);
        if subjects.len() >= 20 {
            break;
        }
    }

    Ok(subjects)
}

async fn query_latest_datetime(
    poneglyph: &poneglyph::Poneglyph,
    query: &str,
    variable_name: &str,
) -> std::result::Result<Option<DateTime<Utc>>, String> {
    let parsed =
        Query::parse(query).map_err(|error| format!("failed to parse query `{query}`: {error}"))?;
    let result = poneglyph
        .query(parsed)
        .await
        .map_err(|error| format!("failed to run query `{query}`: {error}"))?;

    let mut latest: Option<DateTime<Utc>> = None;
    for substitution in result.substitutions() {
        let Some(datafox::Value::String(value)) = substitution.lookup(variable_name) else {
            continue;
        };
        let Ok(parsed) = DateTime::parse_from_rfc3339(value) else {
            continue;
        };
        let value = parsed.with_timezone(&Utc);
        latest = match latest {
            Some(current) if current >= value => Some(current),
            _ => Some(value),
        };
    }

    Ok(latest)
}
