use std::sync::Arc;

use axum::{Router, routing::get};
use derive_builder::Builder;
use poneglyph::Poneglyph;
use poneglyph_ctl::{CtlStore, PoneglyphCtlConfig};
use tower_http::trace::{
    DefaultMakeSpan, DefaultOnFailure, DefaultOnRequest, DefaultOnResponse, TraceLayer,
};
use tracing::debug;

use crate::{
    config::{PoneglyphApiConfig, default_bind_addr},
    context::{AppContext, GoogleOAuthConfig},
    controllers::{auth::google, health},
    error::{Error, Result},
    graphql,
};

#[derive(Clone, Builder)]
#[builder(pattern = "owned", build_fn(private, name = "fallible_build"))]
pub struct PoneglyphApiServer {
    poneglyph: Arc<Poneglyph>,
    ctl: CtlStore,
    #[builder(default = "default_bind_addr()")]
    bind_addr: String,
    #[builder(default)]
    api_config: PoneglyphApiConfig,
    #[builder(default)]
    ctl_config: PoneglyphCtlConfig,
    #[builder(default)]
    google_oauth: GoogleOAuthConfig,
}

impl PoneglyphApiServer {
    pub fn builder() -> PoneglyphApiServerBuilder {
        PoneglyphApiServerBuilder::default()
    }

    pub fn bind_addr(&self) -> &str {
        &self.bind_addr
    }

    pub fn router(&self) -> Router {
        let context = AppContext::new_with_google_oauth(
            self.api_config.clone(),
            self.ctl_config.clone(),
            self.poneglyph.clone(),
            self.ctl.clone(),
            self.google_oauth.clone(),
        );
        Router::new()
            .route("/", get(google::root))
            .route("/health", get(health::health))
            .route("/gql", get(graphql::graphiql).post(graphql::graphql))
            .route("/graphiql", get(graphql::graphiql))
            .route("/auth/google/login", get(google::login))
            .route("/auth/google/callback", get(google::root))
            .route("/auth/google/grant", get(google::grant))
            .route("/auth/google/redeem", get(google::redeem))
            .nest_service("/mcp", context.mcp.router())
            .layer(
                TraceLayer::new_for_http()
                    .make_span_with(DefaultMakeSpan::new().level(tracing::Level::INFO))
                    .on_request(DefaultOnRequest::new().level(tracing::Level::INFO))
                    .on_response(DefaultOnResponse::new().level(tracing::Level::INFO))
                    .on_failure(DefaultOnFailure::new().level(tracing::Level::ERROR)),
            )
            .with_state(context)
    }

    pub async fn run(self) -> Result<()> {
        debug!(
            component = "poneglyph_api",
            bind_addr = %self.bind_addr,
            "starting poneglyph api server"
        );
        let listener = tokio::net::TcpListener::bind(&self.bind_addr).await?;
        axum::serve(listener, self.router()).await?;
        Ok(())
    }
}

impl PoneglyphApiServerBuilder {
    pub fn with_poneglyph(self, poneglyph: Poneglyph) -> Self {
        self.poneglyph(Arc::new(poneglyph))
    }

    pub fn with_poneglyph_arc(self, poneglyph: Arc<Poneglyph>) -> Self {
        self.poneglyph(poneglyph)
    }

    pub fn with_ctl_store(self, ctl: CtlStore) -> Self {
        self.ctl(ctl)
    }

    pub fn with_bind_addr(self, bind_addr: impl Into<String>) -> Self {
        self.bind_addr(bind_addr.into())
    }

    pub fn with_api_config(self, api_config: PoneglyphApiConfig) -> Self {
        self.api_config(api_config)
    }

    pub fn with_ctl_config(self, ctl_config: PoneglyphCtlConfig) -> Self {
        self.ctl_config(ctl_config)
    }

    #[cfg(test)]
    pub(crate) fn with_google_oauth(self, google_oauth: GoogleOAuthConfig) -> Self {
        self.google_oauth(google_oauth)
    }

    pub fn build(self) -> Result<PoneglyphApiServer> {
        self.fallible_build()
            .map_err(|_| Error::MissingServerDependencies)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{Json, Router, routing::post};
    use reqwest::Client;
    use serde_json::json;
    use tempfile::{TempDir, tempdir};

    use super::PoneglyphApiServer;
    use crate::{config::PoneglyphApiConfig, context::GoogleOAuthConfig};
    use poneglyph::{Poneglyph, Query, QueryResult, Workspace};
    use poneglyph_ctl::{CtlStore, PlexConfig, PoneglyphCtlConfig, SaveGoogleOAuthConnection};

    struct TestApiServer {
        _tempdir: TempDir,
        server: PoneglyphApiServer,
    }

    async fn build_server() -> poneglyph::PoneResult<TestApiServer> {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await?;
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let server = PoneglyphApiServer::builder()
            .with_poneglyph(runtime)
            .with_ctl_store(ctl)
            .build()
            .expect("api server");

        Ok(TestApiServer {
            _tempdir: tempdir,
            server,
        })
    }

    fn next_http_bind_addr() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral tcp listener");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);
        addr.to_string()
    }

    #[tokio::test]
    async fn api_server_serves_health_and_google_auth_routes() {
        let TestApiServer { _tempdir, server } = build_server().await.expect("server");
        let bind_addr = next_http_bind_addr();
        let base_url = format!("http://{bind_addr}");
        let server = PoneglyphApiServer {
            bind_addr: bind_addr.clone(),
            ..server
        };
        let server_task = tokio::spawn(server.run());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");

        let health = client
            .get(format!("{base_url}/health"))
            .send()
            .await
            .expect("health");
        assert_eq!(health.status(), 200);

        let root = client.get(&base_url).send().await.expect("root");
        assert_eq!(root.status(), 200);
        let root_body = root.text().await.expect("root body");
        assert!(root_body.contains("Poneglyph API"));

        let login = client
            .get(format!("{base_url}/auth/google/login"))
            .send()
            .await
            .expect("login");
        assert_eq!(login.status(), 307);
        let location = login
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .expect("location");
        assert!(location.starts_with("https://accounts.google.com/o/oauth2/v2/auth"));
        assert!(location.contains(
            "client_id=218820469100-9i3j96lb0ltn3g1sfppuipp3als48o9d.apps.googleusercontent.com"
        ));

        let bad_callback = client
            .get(format!(
                "{base_url}/auth/google/callback?code=test-code&state=missing"
            ))
            .send()
            .await
            .expect("callback");
        assert_eq!(bad_callback.status(), 400);

        let graphiql = client
            .get(format!("{base_url}/graphiql"))
            .send()
            .await
            .expect("graphiql");
        assert_eq!(graphiql.status(), 200);

        let initialize = client
            .post(format!("{base_url}/mcp"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"#)
            .send()
            .await
            .expect("mcp initialize");
        assert_eq!(initialize.status(), 200);

        server_task.abort();
    }

    #[tokio::test]
    async fn google_callback_exchanges_code_and_persists_connection() {
        let oauth_bind_addr = next_http_bind_addr();
        let oauth_listener = tokio::net::TcpListener::bind(&oauth_bind_addr)
            .await
            .expect("oauth listener");
        let oauth_task = tokio::spawn(async move {
            let app = Router::new().route(
                "/token",
                post(|| async {
                    Json(json!({
                        "access_token": "google-access-token",
                        "refresh_token": "google-refresh-token",
                        "token_type": "Bearer",
                        "expires_in": 3600,
                        "scope": "https://www.googleapis.com/auth/calendar.readonly"
                    }))
                }),
            );
            axum::serve(oauth_listener, app).await.expect("oauth serve");
        });

        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await
            .expect("poneglyph");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let bind_addr = next_http_bind_addr();
        let base_url = format!("http://{bind_addr}");
        let server = PoneglyphApiServer::builder()
            .with_poneglyph(runtime)
            .with_ctl_store(ctl.clone())
            .with_bind_addr(bind_addr.clone())
            .with_google_oauth(GoogleOAuthConfig {
                auth_url: format!("http://{oauth_bind_addr}/authorize"),
                token_url: format!("http://{oauth_bind_addr}/token"),
                redirect_uri: base_url.clone(),
                ..GoogleOAuthConfig::default()
            })
            .build()
            .expect("api server");
        let server_task = tokio::spawn(server.run());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");

        let login = client
            .get(format!("{base_url}/auth/google/login"))
            .send()
            .await
            .expect("login");
        let location = login
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .expect("location");
        let redirect = url::Url::parse(location).expect("redirect url");
        let state = redirect
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .expect("state");

        let callback = client
            .get(format!("{base_url}?code=test-code&state={state}"))
            .send()
            .await
            .expect("callback");
        assert_eq!(callback.status(), 200);
        let body = callback.text().await.expect("body");
        assert!(body.contains("You can close this tab now."));

        let connection = ctl
            .latest_google_oauth_connection()
            .await
            .expect("latest")
            .expect("saved");
        assert_eq!(connection.access_token, "google-access-token");
        assert_eq!(
            connection.refresh_token.as_deref(),
            Some("google-refresh-token")
        );
        assert_eq!(connection.token_type, "bearer");

        server_task.abort();
        oauth_task.abort();
    }

    #[tokio::test]
    async fn google_callback_redirects_to_handoff_and_grant_can_be_redeemed() {
        let oauth_bind_addr = next_http_bind_addr();
        let oauth_listener = tokio::net::TcpListener::bind(&oauth_bind_addr)
            .await
            .expect("oauth listener");
        let oauth_task = tokio::spawn(async move {
            let app = Router::new().route(
                "/token",
                post(|| async {
                    Json(json!({
                        "access_token": "google-access-token",
                        "refresh_token": "google-refresh-token",
                        "token_type": "Bearer",
                        "expires_in": 3600,
                        "scope": "https://www.googleapis.com/auth/calendar.readonly"
                    }))
                }),
            );
            axum::serve(oauth_listener, app).await.expect("oauth serve");
        });

        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await
            .expect("poneglyph");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let bind_addr = next_http_bind_addr();
        let base_url = format!("http://{bind_addr}");
        let server = PoneglyphApiServer::builder()
            .with_poneglyph(runtime)
            .with_ctl_store(ctl)
            .with_bind_addr(bind_addr.clone())
            .with_google_oauth(GoogleOAuthConfig {
                auth_url: format!("http://{oauth_bind_addr}/authorize"),
                token_url: format!("http://{oauth_bind_addr}/token"),
                redirect_uri: base_url.clone(),
                ..GoogleOAuthConfig::default()
            })
            .build()
            .expect("api server");
        let server_task = tokio::spawn(server.run());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");

        let handoff_uri = "http://127.0.0.1:8788/auth/google/grant";
        let encoded_handoff_uri: String =
            url::form_urlencoded::byte_serialize(handoff_uri.as_bytes()).collect();
        let login = client
            .get(format!(
                "{base_url}/auth/google/login?handoff_uri={}",
                encoded_handoff_uri
            ))
            .send()
            .await
            .expect("login");
        let location = login
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .expect("location");
        let state = url::Url::parse(location)
            .expect("google auth url")
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .expect("state");

        let callback = client
            .get(format!("{base_url}?code=test-code&state={state}"))
            .send()
            .await
            .expect("callback");
        assert_eq!(callback.status(), 307);
        let handoff_location = callback
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .expect("handoff location");
        assert!(handoff_location.starts_with(handoff_uri));
        let grant = url::Url::parse(handoff_location)
            .expect("handoff url")
            .query_pairs()
            .find(|(key, _)| key == "grant")
            .map(|(_, value)| value.to_string())
            .expect("grant");

        let redeemed = client
            .get(format!("{base_url}/auth/google/redeem?grant={grant}"))
            .send()
            .await
            .expect("redeem");
        assert_eq!(redeemed.status(), 200);
        let redeemed: serde_json::Value = redeemed.json().await.expect("redeemed body");
        assert_eq!(redeemed["grant_id"], grant);
        assert_eq!(redeemed["access_token"], "google-access-token");
        assert_eq!(redeemed["refresh_token"], "google-refresh-token");

        let redeemed_again = client
            .get(format!("{base_url}/auth/google/redeem?grant={grant}"))
            .send()
            .await
            .expect("redeem again");
        assert_eq!(redeemed_again.status(), 404);

        server_task.abort();
        oauth_task.abort();
    }

    #[tokio::test]
    async fn local_google_callback_redeems_remote_handoff_grant_and_persists_connection() {
        let oauth_bind_addr = next_http_bind_addr();
        let oauth_listener = tokio::net::TcpListener::bind(&oauth_bind_addr)
            .await
            .expect("oauth listener");
        let oauth_task = tokio::spawn(async move {
            let app = Router::new().route(
                "/token",
                post(|| async {
                    Json(json!({
                        "access_token": "google-access-token",
                        "refresh_token": "google-refresh-token",
                        "token_type": "Bearer",
                        "expires_in": 3600,
                        "scope": "https://www.googleapis.com/auth/calendar.readonly"
                    }))
                }),
            );
            axum::serve(oauth_listener, app).await.expect("oauth serve");
        });

        let remote_tempdir = tempdir().expect("remote tempdir");
        let remote_workspace = Workspace::at(remote_tempdir.path());
        let remote_runtime = Poneglyph::builder()
            .with_workspace(remote_workspace)
            .build()
            .await
            .expect("remote poneglyph");
        let remote_ctl = CtlStore::open(remote_tempdir.path().join("control.db"))
            .await
            .expect("remote ctl");
        let remote_bind_addr = next_http_bind_addr();
        let remote_base_url = format!("http://{remote_bind_addr}");

        let local_tempdir = tempdir().expect("local tempdir");
        let local_workspace = Workspace::at(local_tempdir.path());
        let local_runtime = Poneglyph::builder()
            .with_workspace(local_workspace)
            .build()
            .await
            .expect("local poneglyph");
        let local_ctl = CtlStore::open(local_tempdir.path().join("control.db"))
            .await
            .expect("local ctl");
        let local_bind_addr = next_http_bind_addr();
        let local_base_url = format!("http://{local_bind_addr}");

        let remote_server = PoneglyphApiServer::builder()
            .with_poneglyph(remote_runtime)
            .with_ctl_store(remote_ctl)
            .with_bind_addr(remote_bind_addr.clone())
            .with_api_config(PoneglyphApiConfig {
                bind_addr: remote_bind_addr.clone(),
                google_auth_base_url: None,
            })
            .with_google_oauth(GoogleOAuthConfig {
                auth_url: format!("http://{oauth_bind_addr}/authorize"),
                token_url: format!("http://{oauth_bind_addr}/token"),
                redirect_uri: remote_base_url.clone(),
                ..GoogleOAuthConfig::default()
            })
            .build()
            .expect("remote api server");
        let local_server = PoneglyphApiServer::builder()
            .with_poneglyph(local_runtime)
            .with_ctl_store(local_ctl.clone())
            .with_bind_addr(local_bind_addr.clone())
            .with_api_config(PoneglyphApiConfig {
                bind_addr: local_bind_addr.clone(),
                google_auth_base_url: Some(remote_base_url.clone()),
            })
            .build()
            .expect("local api server");

        let remote_task = tokio::spawn(remote_server.run());
        let local_task = tokio::spawn(local_server.run());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");

        let handoff_uri = format!("{local_base_url}/auth/google/grant");
        let encoded_handoff_uri: String =
            url::form_urlencoded::byte_serialize(handoff_uri.as_bytes()).collect();
        let login = client
            .get(format!(
                "{remote_base_url}/auth/google/login?handoff_uri={encoded_handoff_uri}"
            ))
            .send()
            .await
            .expect("login");
        let location = login
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .expect("location");
        let state = url::Url::parse(location)
            .expect("google auth url")
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .expect("state");

        let hosted_callback = client
            .get(format!("{remote_base_url}?code=test-code&state={state}"))
            .send()
            .await
            .expect("hosted callback");
        assert_eq!(hosted_callback.status(), 307);
        let localhost_redirect = hosted_callback
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .expect("localhost redirect");
        assert!(localhost_redirect.starts_with(&handoff_uri));

        let local_callback = client
            .get(localhost_redirect)
            .send()
            .await
            .expect("local callback");
        assert_eq!(local_callback.status(), 200);
        let local_body = local_callback.text().await.expect("local body");
        assert!(local_body.contains("You can close this tab now"));

        let latest = local_ctl
            .latest_google_oauth_connection()
            .await
            .expect("latest local connection")
            .expect("persisted connection");
        assert_eq!(latest.access_token, "google-access-token");
        assert_eq!(
            latest.refresh_token.as_deref(),
            Some("google-refresh-token")
        );

        local_task.abort();
        remote_task.abort();
        oauth_task.abort();
    }

    #[tokio::test]
    async fn graphql_google_calendars_list_discover_and_update_selection() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await
            .expect("poneglyph");
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let connection = ctl
            .save_google_oauth_connection(SaveGoogleOAuthConnection {
                access_token: "google-access-token".to_string(),
                refresh_token: Some("google-refresh-token".to_string()),
                token_type: "Bearer".to_string(),
                scopes: vec!["https://www.googleapis.com/auth/calendar.readonly".to_string()],
                expires_at: None,
            })
            .await
            .expect("connection");
        ctl.save_google_calendar_resources(
            connection.id,
            vec![
                poneglyph_ctl::GoogleCalendarResource {
                    calendar_id: "primary".to_string(),
                    summary: "Primary".to_string(),
                    description: Some("Main".to_string()),
                    time_zone: Some("Europe/Prague".to_string()),
                    primary: true,
                    selected: false,
                },
                poneglyph_ctl::GoogleCalendarResource {
                    calendar_id: "work".to_string(),
                    summary: "Work".to_string(),
                    description: None,
                    time_zone: Some("Europe/Prague".to_string()),
                    primary: false,
                    selected: false,
                },
            ],
        )
        .await
        .expect("save calendars");

        let bind_addr = next_http_bind_addr();
        let base_url = format!("http://{bind_addr}");
        let server = PoneglyphApiServer::builder()
            .with_poneglyph(runtime)
            .with_ctl_store(ctl.clone())
            .with_bind_addr(bind_addr.clone())
            .build()
            .expect("api server");
        let server_task = tokio::spawn(server.run());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");

        let listed = client
            .post(format!("{base_url}/gql"))
            .json(&json!({
                "query": "{ googleCalendars { calendarId summary selected } }"
            }))
            .send()
            .await
            .expect("graphql list calendars");
        assert_eq!(listed.status(), 200);
        let listed: serde_json::Value = listed.json().await.expect("listed body");
        assert_eq!(
            listed["data"]["googleCalendars"]
                .as_array()
                .expect("array")
                .len(),
            2
        );

        let selected = client
            .post(format!("{base_url}/gql"))
            .json(&json!({
                "query": "mutation($input: SelectGoogleCalendarsInput!) { selectGoogleCalendars(input: $input) { calendarId selected } }",
                "variables": { "input": { "calendarIds": ["work"] } }
            }))
            .send()
            .await
            .expect("graphql select calendars");
        assert_eq!(selected.status(), 200);
        let selected: serde_json::Value = selected.json().await.expect("selected body");
        assert!(
            selected["data"]["selectGoogleCalendars"]
                .as_array()
                .expect("array")
                .iter()
                .any(|calendar| calendar["calendarId"] == "work" && calendar["selected"] == true)
        );

        server_task.abort();
    }

    #[tokio::test]
    async fn graphql_connector_statuses_and_sync_connector_drive_plex() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let addr = listener.local_addr().expect("addr");
        let app = Router::new()
            .route(
                "/library/sections/all",
                axum::routing::get(|| async {
                    Json(json!({
                        "MediaContainer": {
                            "Directory": [
                                {
                                    "key": "5",
                                    "title": "Movies",
                                    "type": "movie",
                                    "Location": [{ "path": "/media/movies" }]
                                }
                            ]
                        }
                    }))
                }),
            )
            .route(
                "/library/sections/5/all",
                axum::routing::get(|| async {
                    Json(json!({
                        "MediaContainer": {
                            "Metadata": [
                                {
                                    "ratingKey": "101",
                                    "key": "/library/metadata/101",
                                    "guid": "plex://movie/dune",
                                    "type": "movie",
                                    "title": "Dune",
                                    "summary": "Spice.",
                                    "year": 2021,
                                    "addedAt": 1710000000,
                                    "updatedAt": 1710000100
                                }
                            ]
                        }
                    }))
                }),
            );
        let plex_task = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Arc::new(
            Poneglyph::builder()
                .with_workspace(workspace)
                .build()
                .await
                .expect("runtime"),
        );
        let ctl = CtlStore::open(tempdir.path().join("control.db"))
            .await
            .expect("ctl");
        let ctl_config = PoneglyphCtlConfig {
            gcal: None,
            plex: Some(PlexConfig {
                enabled: true,
                base_url: Some(format!("http://{addr}")),
                token: Some("secret".to_string()),
                libraries: vec!["Movies".to_string()],
            }),
        };

        let bind_addr = next_http_bind_addr();
        let base_url = format!("http://{bind_addr}");
        let server = PoneglyphApiServer::builder()
            .with_poneglyph_arc(runtime.clone())
            .with_ctl_store(ctl)
            .with_ctl_config(ctl_config)
            .with_bind_addr(bind_addr.clone())
            .build()
            .expect("api server");
        let server_task = tokio::spawn(server.run());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");

        let statuses = client
            .post(format!("{base_url}/gql"))
            .json(&json!({
                "query": "{ connectorStatuses { name enabled connected selectedResourceCount } }"
            }))
            .send()
            .await
            .expect("graphql statuses");
        assert_eq!(statuses.status(), 200);
        let statuses: serde_json::Value = statuses.json().await.expect("statuses body");
        assert!(
            statuses["data"]["connectorStatuses"]
                .as_array()
                .expect("array")
                .iter()
                .any(|status| {
                    status["name"] == "plex"
                        && status["enabled"] == true
                        && status["connected"] == true
                        && status["selectedResourceCount"] == 1
                })
        );

        let sync = client
            .post(format!("{base_url}/gql"))
            .json(&json!({
                "query": "mutation { syncConnector(name: \"plex\") { name synced message } }"
            }))
            .send()
            .await
            .expect("graphql sync");
        assert_eq!(sync.status(), 200);
        let sync: serde_json::Value = sync.json().await.expect("sync body");
        assert_eq!(sync["data"]["syncConnector"]["name"], "plex");
        assert_eq!(sync["data"]["syncConnector"]["synced"], true);

        let result: QueryResult = runtime
            .query(Query::parse("'plex:title'(Library, \"Movies\")").expect("query"))
            .await
            .expect("query result");
        assert_eq!(result.len(), 1);

        let item_result: QueryResult = runtime
            .query(Query::parse("'plex:title'(Item, \"Dune\")").expect("query"))
            .await
            .expect("item query result");
        assert_eq!(item_result.len(), 1);

        server_task.abort();
        plex_task.abort();
    }
}
