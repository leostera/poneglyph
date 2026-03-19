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
struct GoogleCalendarResourceObject {
    calendar_id: String,
    summary: String,
    description: Option<String>,
    time_zone: Option<String>,
    primary: bool,
    selected: bool,
}

#[derive(InputObject)]
struct SelectGoogleCalendarsInput {
    calendar_ids: Vec<String>,
}

#[Object]
impl ApiQuery {
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
}

#[Object]
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
            calendar_id: calendar.calendar_id,
            summary: calendar.summary,
            description: calendar.description,
            time_zone: calendar.time_zone,
            primary: calendar.primary,
            selected: calendar.selected,
        })
        .collect()
}
