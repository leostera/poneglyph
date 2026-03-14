use std::{future::Future, sync::Arc};

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
use tracing::debug;

use crate::{Error, PoneglyphMcpServer, Result, ToolCall};

#[derive(Clone)]
struct RmcpHandler {
    inner: Arc<PoneglyphMcpServer>,
}

pub(crate) fn router(inner: PoneglyphMcpServer) -> Router {
    debug!("building rmcp streamable http router");
    let handler = RmcpHandler {
        inner: Arc::new(inner),
    };
    let service: StreamableHttpService<RmcpHandler, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(handler.clone()),
            Default::default(),
            http_config(),
        );
    Router::new().fallback_service(service)
}

fn http_config() -> StreamableHttpServerConfig {
    StreamableHttpServerConfig {
        stateful_mode: false,
        json_response: true,
        sse_keep_alive: None,
        ..Default::default()
    }
}

impl ServerHandler for RmcpHandler {
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
        Error::Io(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::Poneglyph(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::MissingServerPoneglyph => {
            ::rmcp::ErrorData::internal_error("missing poneglyph runtime", None)
        }
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
    use reqwest::Client;
    use serde_json::Value;
    use tempfile::{TempDir, tempdir};

    use super::router;
    use crate::PoneglyphMcpServer;
    use poneglyph::{Poneglyph, Workspace};

    struct TestRmcpRouter {
        _tempdir: TempDir,
        router: Router,
    }

    use axum::Router;

    async fn build_router() -> poneglyph::PoneResult<TestRmcpRouter> {
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

        Ok(TestRmcpRouter {
            _tempdir: tempdir,
            router: router(inner),
        })
    }

    fn next_http_bind_addr() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral tcp listener");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);
        addr.to_string()
    }

    #[tokio::test]
    async fn rmcp_router_serves_tools_over_http() {
        let TestRmcpRouter { _tempdir, router } = build_router().await.expect("router");
        let bind_addr = next_http_bind_addr();
        let base_url = format!("http://{bind_addr}/mcp");
        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .expect("listener");
        let server_task = tokio::spawn(async move {
            axum::serve(listener, Router::new().nest("/mcp", router))
                .await
                .expect("serve");
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
            .expect("tools/list");

        assert_eq!(tools.status(), 200);
        let body: Value = tools.json().await.expect("tools body");
        let names = body["result"]["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"query"));
        assert!(names.contains(&"stateFacts"));

        server_task.abort();
    }
}
