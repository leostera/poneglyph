use std::sync::Arc;

use axum::{Router, routing::get};
use derive_builder::Builder;
use poneglyph::Poneglyph;
use poneglyph_ctl::CtlStore;
use tower_http::trace::{
    DefaultMakeSpan, DefaultOnFailure, DefaultOnRequest, DefaultOnResponse, TraceLayer,
};
use tracing::debug;

use crate::{
    config::default_bind_addr,
    context::{AppContext, GoogleOAuthConfig},
    controllers::{auth::google, health},
    error::{Error, Result},
};

#[derive(Clone, Builder)]
#[builder(pattern = "owned", build_fn(private, name = "fallible_build"))]
pub struct PoneglyphApiServer {
    poneglyph: Arc<Poneglyph>,
    ctl: CtlStore,
    #[builder(default = "default_bind_addr()")]
    bind_addr: String,
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
            self.poneglyph.clone(),
            self.ctl.clone(),
            self.google_oauth.clone(),
        );
        Router::new()
            .route("/", get(google::root))
            .route("/health", get(health::health))
            .route("/auth/google/login", get(google::login))
            .route("/auth/google/callback", get(google::callback))
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
    use axum::{Json, Router, routing::post};
    use reqwest::Client;
    use serde_json::json;
    use tempfile::{TempDir, tempdir};

    use super::PoneglyphApiServer;
    use crate::context::GoogleOAuthConfig;
    use poneglyph::{Poneglyph, Workspace};
    use poneglyph_ctl::CtlStore;

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
}
