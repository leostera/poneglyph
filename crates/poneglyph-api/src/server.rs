use std::sync::Arc;

use axum::{Router, routing::get};
use derive_builder::Builder;
use poneglyph::Poneglyph;
use tower_http::trace::{
    DefaultMakeSpan, DefaultOnFailure, DefaultOnRequest, DefaultOnResponse, TraceLayer,
};
use tracing::debug;

use crate::{
    config::default_bind_addr,
    context::AppContext,
    controllers::{auth::google, health},
    error::{Error, Result},
};

#[derive(Clone, Builder)]
#[builder(pattern = "owned", build_fn(private, name = "fallible_build"))]
pub struct PoneglyphApiServer {
    poneglyph: Arc<Poneglyph>,
    #[builder(default = "default_bind_addr()")]
    bind_addr: String,
}

impl PoneglyphApiServer {
    pub fn builder() -> PoneglyphApiServerBuilder {
        PoneglyphApiServerBuilder::default()
    }

    pub fn bind_addr(&self) -> &str {
        &self.bind_addr
    }

    pub fn router(&self) -> Router {
        let context = AppContext::new(self.poneglyph.clone());
        Router::new()
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

    pub fn with_bind_addr(self, bind_addr: impl Into<String>) -> Self {
        self.bind_addr(bind_addr.into())
    }

    pub fn build(self) -> Result<PoneglyphApiServer> {
        self.fallible_build()
            .map_err(|_| Error::MissingServerPoneglyph)
    }
}

#[cfg(test)]
mod tests {
    use reqwest::Client;
    use tempfile::{TempDir, tempdir};

    use super::PoneglyphApiServer;
    use poneglyph::{Poneglyph, Workspace};

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
        let server = PoneglyphApiServer::builder()
            .with_poneglyph(runtime)
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
}
