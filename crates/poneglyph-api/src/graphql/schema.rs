use async_graphql::{
    EmptySubscription, InputObject, Object, Result, Schema, SimpleObject, http::GraphiQLSource,
};
use async_graphql_axum::{GraphQLRequest, GraphQLResponse};
use axum::{
    extract::State,
    response::{Html, IntoResponse},
};

use crate::{context::AppContext, services::google};

pub(crate) type ApiSchema = Schema<ApiQuery, ApiMutation, EmptySubscription>;

pub(crate) struct ApiQuery;
pub(crate) struct ApiMutation;

#[derive(SimpleObject)]
#[graphql(name = "GoogleCalendarResource")]
struct GoogleCalendarResourceObject {
    connection_id: i64,
    calendar_id: String,
    summary: String,
    description: Option<String>,
    time_zone: Option<String>,
    primary: bool,
    selected: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "GoogleCalendarConnection")]
struct GoogleCalendarConnectionObject {
    id: i64,
    label: String,
    selected_resource_count: i32,
    last_synced_at: Option<String>,
    last_error: Option<String>,
    calendars: Vec<GoogleCalendarResourceObject>,
}

#[derive(SimpleObject)]
#[graphql(name = "ConnectorStatus")]
struct ConnectorStatusObject {
    name: String,
    enabled: bool,
    connected: bool,
    selected_resource_count: i32,
    last_synced_at: Option<String>,
    last_error: Option<String>,
}

#[derive(SimpleObject)]
#[graphql(name = "ConnectorSyncResult")]
struct ConnectorSyncResultObject {
    name: String,
    synced: bool,
    message: String,
}

#[derive(InputObject)]
#[graphql(name = "SelectGoogleCalendarsInput")]
struct SelectGoogleCalendarsInput {
    calendar_ids: Vec<String>,
}

#[Object(name = "Query")]
impl ApiQuery {
    async fn google_calendar_connections(
        &self,
        ctx: &async_graphql::Context<'_>,
    ) -> Result<Vec<GoogleCalendarConnectionObject>> {
        let app = ctx.data::<AppContext>()?;
        google::list_google_connections(app)
            .await
            .map(map_google_connections)
            .map_err(async_graphql::Error::new)
    }

    async fn google_calendars(
        &self,
        ctx: &async_graphql::Context<'_>,
    ) -> Result<Vec<GoogleCalendarResourceObject>> {
        let app = ctx.data::<AppContext>()?;
        google::list_calendars(app)
            .await
            .map(map_google_calendars)
            .map_err(async_graphql::Error::new)
    }

    async fn connector_statuses(
        &self,
        ctx: &async_graphql::Context<'_>,
    ) -> Result<Vec<ConnectorStatusObject>> {
        let app = ctx.data::<AppContext>()?;
        google::connector_statuses(app)
            .await
            .map(map_connector_statuses)
            .map_err(async_graphql::Error::new)
    }
}

#[Object(name = "Mutation")]
impl ApiMutation {
    async fn discover_google_calendars(
        &self,
        ctx: &async_graphql::Context<'_>,
    ) -> Result<Vec<GoogleCalendarResourceObject>> {
        let app = ctx.data::<AppContext>()?;
        google::discover_calendars(app)
            .await
            .map(map_google_calendars)
            .map_err(async_graphql::Error::new)
    }

    async fn discover_google_calendars_for_connection(
        &self,
        ctx: &async_graphql::Context<'_>,
        connection_id: i64,
    ) -> Result<Vec<GoogleCalendarResourceObject>> {
        let app = ctx.data::<AppContext>()?;
        google::discover_calendars_for_connection(app, connection_id)
            .await
            .map(map_google_calendars)
            .map_err(async_graphql::Error::new)
    }

    async fn select_google_calendars(
        &self,
        ctx: &async_graphql::Context<'_>,
        input: SelectGoogleCalendarsInput,
    ) -> Result<Vec<GoogleCalendarResourceObject>> {
        let app = ctx.data::<AppContext>()?;
        google::select_calendars(app, &input.calendar_ids)
            .await
            .map(map_google_calendars)
            .map_err(async_graphql::Error::new)
    }

    async fn select_google_calendars_for_connection(
        &self,
        ctx: &async_graphql::Context<'_>,
        connection_id: i64,
        input: SelectGoogleCalendarsInput,
    ) -> Result<Vec<GoogleCalendarResourceObject>> {
        let app = ctx.data::<AppContext>()?;
        google::select_calendars_for_connection(app, connection_id, &input.calendar_ids)
            .await
            .map(map_google_calendars)
            .map_err(async_graphql::Error::new)
    }

    async fn sync_connector(
        &self,
        ctx: &async_graphql::Context<'_>,
        name: String,
    ) -> Result<ConnectorSyncResultObject> {
        let app = ctx.data::<AppContext>()?;
        google::sync_connector(app, &name)
            .await
            .map(map_connector_sync_result)
            .map_err(async_graphql::Error::new)
    }
}

pub(crate) async fn graphql(
    State(context): State<AppContext>,
    req: GraphQLRequest,
) -> GraphQLResponse {
    schema(context).execute(req.into_inner()).await.into()
}

pub(crate) async fn graphiql() -> impl IntoResponse {
    Html(GraphiQLSource::build().endpoint("/gql").finish())
}

#[cfg(test)]
pub(crate) fn schema_sdl() -> String {
    Schema::build(ApiQuery, ApiMutation, EmptySubscription)
        .finish()
        .sdl()
}

fn schema(context: AppContext) -> ApiSchema {
    Schema::build(ApiQuery, ApiMutation, EmptySubscription)
        .data(context)
        .finish()
}

fn map_google_calendars(
    calendars: Vec<google::GoogleCalendarResource>,
) -> Vec<GoogleCalendarResourceObject> {
    calendars
        .into_iter()
        .map(|calendar| GoogleCalendarResourceObject {
            connection_id: calendar.connection_id,
            calendar_id: calendar.calendar_id,
            summary: calendar.summary,
            description: calendar.description,
            time_zone: calendar.time_zone,
            primary: calendar.primary,
            selected: calendar.selected,
        })
        .collect()
}

fn map_google_connections(
    connections: Vec<google::GoogleCalendarConnection>,
) -> Vec<GoogleCalendarConnectionObject> {
    connections
        .into_iter()
        .map(|connection| GoogleCalendarConnectionObject {
            id: connection.id,
            label: connection.label,
            selected_resource_count: connection.selected_resource_count,
            last_synced_at: connection.last_synced_at.map(|value| value.to_rfc3339()),
            last_error: connection.last_error,
            calendars: map_google_calendars(connection.calendars),
        })
        .collect()
}

fn map_connector_statuses(statuses: Vec<google::ConnectorStatus>) -> Vec<ConnectorStatusObject> {
    statuses
        .into_iter()
        .map(|status| ConnectorStatusObject {
            name: status.name,
            enabled: status.enabled,
            connected: status.connected,
            selected_resource_count: status.selected_resource_count,
            last_synced_at: status.last_synced_at.map(|value| value.to_rfc3339()),
            last_error: status.last_error,
        })
        .collect()
}

fn map_connector_sync_result(result: google::ConnectorSyncResult) -> ConnectorSyncResultObject {
    ConnectorSyncResultObject {
        name: result.name,
        synced: result.synced,
        message: result.message,
    }
}

#[cfg(test)]
mod tests {
    use super::schema_sdl;

    #[test]
    fn generated_schema_matches_checked_in_schema_file() {
        let generated = schema_sdl();
        let checked_in = include_str!("../../schema.graphql");

        assert_eq!(normalize_sdl(&generated), normalize_sdl(checked_in));
    }

    fn normalize_sdl(sdl: &str) -> String {
        sdl.lines()
            .map(str::trim)
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
