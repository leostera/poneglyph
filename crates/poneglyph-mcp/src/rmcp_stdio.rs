use std::sync::Arc;

use ::rmcp::{
    ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
        ServerInfo, Tool as RmcpTool, ToolsCapability,
    },
    service::RequestContext,
    transport,
};
use serde_json::Value;
use tracing::{debug, instrument};

use crate::{Error, PoneglyphMcpServer, Result, ToolCall};

/// RMCP-backed stdio server for [`PoneglyphMcpServer`].
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
        self.serve_stdio().await
    }

    #[instrument(skip(self), fields(component = "poneglyph_mcp"))]
    pub async fn serve_stdio(self) -> Result<()> {
        debug!("starting RMCP stdio server");
        let server = self.serve(transport::stdio()).await?;
        server.waiting().await?;
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
        Error::Poneglyph(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::MissingServerPoneglyph => {
            ::rmcp::ErrorData::internal_error("missing poneglyph runtime", None)
        }
        Error::RmcpServerInitialize(source) => {
            ::rmcp::ErrorData::internal_error(source.to_string(), None)
        }
        Error::RmcpJoin(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
        Error::RmcpService(source) => ::rmcp::ErrorData::internal_error(source.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use rmcp::{ServiceExt, model::CallToolRequestParams};
    use serde_json::{Map, Value, json};
    use tempfile::{TempDir, tempdir};

    use super::RmcpServer;
    use crate::PoneglyphMcpServer;
    use poneglyph::{Poneglyph, Workspace, fact, uri};

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
        assert!(names.contains(&"Poneglyph-query".to_string()));
        assert!(names.contains(&"Poneglyph-stateFacts".to_string()));

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
                CallToolRequestParams::new("Poneglyph-stateFacts").with_arguments(object(json!({
                    "facts": [
                        fact!(
                            uri!("spotify:album:2112"),
                            uri!("spotify:displayName"),
                            poneglyph::Value::text("2112")
                        )
                    ]
                }))),
            )
            .await
            .expect("state facts");

        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("Poneglyph-query").with_arguments(object(json!({
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

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            other => panic!("expected object, got {other:?}"),
        }
    }
}
