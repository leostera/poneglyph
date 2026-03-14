use std::sync::Arc;

use ::rmcp::{
    ServerHandler,
    model::{
        CallToolRequestParams, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
        ServerInfo, Tool as RmcpTool, ToolsCapability,
    },
    service::RequestContext,
    transport::{
        StreamableHttpServerConfig, StreamableHttpService,
        streamable_http_server::session::local::LocalSessionManager,
    },
};
use axum::Router;
use serde_json::Value;
use tracing::{debug, instrument};

use crate::{Error, PoneglyphMcpServer, Result, ToolCall};

/// RMCP-backed transport host for [`PoneglyphMcpServer`].
#[derive(Clone)]
pub struct RmcpServer {
    inner: Arc<PoneglyphMcpServer>,
}

impl RmcpServer {
    pub fn new(inner: PoneglyphMcpServer) -> Self {
        Self {
            inner: Arc::new(inner),
        }
    }

    #[instrument(skip(self), fields(component = "poneglyph_mcp"))]
    pub async fn run(self) -> Result<()> {
        let bind_addr = self.inner.bind_addr().to_string();
        self.serve_http(&bind_addr).await
    }

    #[instrument(skip(self), fields(component = "poneglyph_mcp", bind_addr = bind_addr))]
    pub async fn serve_http(self, bind_addr: &str) -> Result<()> {
        self.serve_http_with_config(bind_addr, StreamableHttpServerConfig::default())
            .await
    }

    #[instrument(skip(self, config), fields(component = "poneglyph_mcp", bind_addr = bind_addr))]
    async fn serve_http_with_config(
        self,
        bind_addr: &str,
        config: StreamableHttpServerConfig,
    ) -> Result<()> {
        debug!("starting RMCP streamable HTTP server");
        let service: StreamableHttpService<Self, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(self.clone()), Default::default(), config);
        let router = Router::new().nest_service("/mcp", service);
        let listener = tokio::net::TcpListener::bind(bind_addr).await?;
        axum::serve(listener, router).await?;
        Ok(())
    }
}

impl ServerHandler for RmcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools_with(ToolsCapability {
                    list_changed: Some(false),
                })
                .build(),
        )
        .with_instructions(
            "Use Poneglyph tools to state facts, query the active graph, fetch entities, and search the projected index.",
        )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<::rmcp::RoleServer>,
    ) -> impl Future<Output = std::result::Result<ListToolsResult, ::rmcp::ErrorData>> + Send + '_
    {
        let tools = self
            .inner
            .list_tools()
            .into_iter()
            .map(into_rmcp_tool)
            .collect::<Result<Vec<_>>>();

        async move {
            let tools = tools.map_err(to_rmcp_error)?;
            Ok(ListToolsResult::with_all_items(tools))
        }
    }

    fn get_tool(&self, name: &str) -> Option<RmcpTool> {
        self.inner
            .list_tools()
            .into_iter()
            .find(|tool| tool.name == name)
            .and_then(|tool| into_rmcp_tool(tool).ok())
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<::rmcp::RoleServer>,
    ) -> impl Future<Output = std::result::Result<::rmcp::model::CallToolResult, ::rmcp::ErrorData>>
    + Send
    + '_ {
        async move {
            let arguments = request.arguments.map(Value::Object).unwrap_or(Value::Null);
            let result = self
                .inner
                .call_tool(ToolCall {
                    name: request.name.to_string(),
                    arguments,
                })
                .await
                .map_err(to_rmcp_error)?;

            Ok(::rmcp::model::CallToolResult::structured(result.content))
        }
    }
}

fn into_rmcp_tool(tool: crate::Tool) -> Result<RmcpTool> {
    let input_schema = match tool.input_schema {
        Value::Object(input_schema) => input_schema,
        _ => {
            return Err(Error::InvalidToolSchema { tool: tool.name });
        }
    };

    Ok(RmcpTool::new(
        tool.name,
        tool.description,
        Arc::new(input_schema),
    ))
}

fn to_rmcp_error(error: Error) -> ::rmcp::ErrorData {
    match error {
        Error::UnknownTool { name } => ::rmcp::ErrorData::invalid_params(name, None),
        Error::InvalidToolInput { tool, source } => {
            ::rmcp::ErrorData::invalid_params(format!("{tool}: {source}"), None)
        }
        Error::InvalidToolOutput { tool, source } => {
            ::rmcp::ErrorData::internal_error(format!("{tool}: {source}"), None)
        }
        Error::InvalidToolSchema { tool } => {
            ::rmcp::ErrorData::internal_error(format!("{tool}: invalid input schema"), None)
        }
        Error::McpBindAddress(source) => {
            ::rmcp::ErrorData::internal_error(source.to_string(), None)
        }
        Error::Io(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::Poneglyph(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::MissingServerPoneglyph => {
            ::rmcp::ErrorData::internal_error("missing poneglyph runtime", None)
        }
        Error::RmcpServerInitialize(source) => {
            ::rmcp::ErrorData::internal_error(source.to_string(), None)
        }
        Error::RmcpJoin(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::RmcpService(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::InvalidToolCallResult(error) => {
            ::rmcp::ErrorData::internal_error(error.to_string(), None)
        }
        error @ Error::StatingFactsOfUnknownEntities { .. } => {
            ::rmcp::ErrorData::internal_error(error.to_string(), None)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use reqwest::Client;
    use rmcp::{ServiceExt, model::CallToolRequestParams, transport::StreamableHttpServerConfig};
    use serde_json::{Map, Value, json};
    use tempfile::{TempDir, tempdir};

    use super::RmcpServer;
    use crate::PoneglyphMcpServer;
    use poneglyph::{Poneglyph, Workspace};

    struct TestRmcpServer {
        _tempdir: TempDir,
        server: RmcpServer,
    }

    async fn build_server() -> poneglyph::PoneResult<TestRmcpServer> {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await?;
        let inner = PoneglyphMcpServer::builder()
            .with_poneglyph(runtime)
            .build()
            .expect("mcp server");

        Ok(TestRmcpServer {
            _tempdir: tempdir,
            server: RmcpServer::new(inner),
        })
    }

    fn next_http_bind_addr() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("ephemeral tcp listener");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);
        addr.to_string()
    }

    #[tokio::test]
    async fn rmcp_server_lists_tools_over_transport() {
        let TestRmcpServer { _tempdir, server } = build_server().await.expect("server");
        let (server_transport, client_transport) = tokio::io::duplex(4096);

        let server_task = tokio::spawn(async move {
            let server = server.serve(server_transport).await.expect("rmcp serve");
            server.waiting().await.expect("server waiting");
        });
        let client = ().serve(client_transport).await.expect("client");

        let tools = client
            .peer()
            .list_tools(Default::default())
            .await
            .expect("list tools");

        let names = tools
            .tools
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();
        assert!(names.contains(&"query".to_string()));
        assert!(names.contains(&"stateFacts".to_string()));

        drop(client);
        server_task.await.expect("server task");
    }

    #[tokio::test]
    async fn rmcp_server_calls_tools_over_transport() {
        let TestRmcpServer { _tempdir, server } = build_server().await.expect("server");
        let (server_transport, client_transport) = tokio::io::duplex(4096);

        let server_task = tokio::spawn(async move {
            let server = server.serve(server_transport).await.expect("rmcp serve");
            server.waiting().await.expect("server waiting");
        });
        let client = ().serve(client_transport).await.expect("client");

        client
            .peer()
            .call_tool(
                CallToolRequestParams::new("stateFacts").with_arguments(object(json!({
                    "entities": ["spotify:album:2112"],
                    "facts": [
                        {
                            "entity": "spotify:album:2112",
                            "field": "spotify:displayName",
                            "value": {
                                "type": "text",
                                "value": "2112"
                            }
                        }
                    ]
                }))),
            )
            .await
            .expect("state facts");

        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("query").with_arguments(object(json!({
                    "query": r#"spotify:displayName(Album, "2112")"#
                }))),
            )
            .await
            .expect("query");

        assert!(result.structured_content.is_some());
        let structured = result.structured_content.expect("structured content");
        assert_eq!(
            structured["substitutions"].as_array().map(Vec::len),
            Some(1)
        );

        drop(client);
        server_task.await.expect("server task");
    }

    #[tokio::test]
    async fn rmcp_server_serves_tools_over_http() {
        let TestRmcpServer { _tempdir, server } = build_server().await.expect("server");
        let bind_addr = next_http_bind_addr();
        let base_url = format!("http://{bind_addr}/mcp");
        let server_task = tokio::spawn({
            let bind_addr = bind_addr.clone();
            async move {
                server
                    .serve_http_with_config(
                        &bind_addr,
                        StreamableHttpServerConfig {
                            stateful_mode: false,
                            json_response: true,
                            sse_keep_alive: None,
                            ..Default::default()
                        },
                    )
                    .await
                    .expect("http serve")
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let client = Client::new();
        let initialize = client
            .post(&base_url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"#)
            .send()
            .await
            .expect("initialize");

        assert_eq!(initialize.status(), 200);

        let tools = client
            .post(&base_url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#)
            .send()
            .await
            .expect("tools list");

        assert_eq!(tools.status(), 200);
        let body = tools.text().await.expect("tools list body");
        assert!(body.contains("query"));
        assert!(body.contains("stateFacts"));

        server_task.abort();
    }

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            other => panic!("expected object, got {other:?}"),
        }
    }
}
