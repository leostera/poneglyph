use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use derive_builder::Builder;
use poneglyph::{
    Entity, Fact, Poneglyph, Query, SearchHit, Uri, Value as PoneglyphValue, fact, uri,
};
use poneglyph_agent::GET_SCHEMA_TOOL_DESCRIPTION;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::debug;

use crate::error::{Error, Result};
use crate::rmcp_http;
use crate::tool::{CallToolResult, Tool, ToolCall};

const TOOL_STATE_FACTS: &str = "stateFacts";
const TOOL_CREATE_ENTITY: &str = "createEntity";
const TOOL_QUERY: &str = "query";
const TOOL_GET_SCHEMA: &str = "getSchema";
const TOOL_GET_ENTITY: &str = "getEntity";
const TOOL_SEARCH: &str = "search";
const TOOL_MESSAGE_AGENT: &str = "messageAgent";
const MESSAGE_AGENT_DESCRIPTION: &str = r#"Send a message to the built-in poneglyph-agent.

Use this when you want Poneglyph's own graph expert to inspect schema, search for existing entities, or extract facts for you.

If `sessionId` is omitted, a new session is created."#;

#[async_trait]
pub trait AgentMessageHandler: Send + Sync {
    async fn send_message(
        &self,
        request: AgentMessageRequest,
    ) -> std::result::Result<AgentMessageResponse, String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMessageRequest {
    pub message: String,
    pub session_id: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMessageResponse {
    pub session_id: String,
    pub run_id: String,
    pub reply: String,
}

#[derive(Clone, Builder)]
#[builder(pattern = "owned", build_fn(private, name = "fallible_build"))]
pub struct PoneglyphMcpServer {
    poneglyph: Arc<Poneglyph>,
    #[builder(default)]
    agent_handler: Option<Arc<dyn AgentMessageHandler>>,
}

impl PoneglyphMcpServer {
    pub fn builder() -> PoneglyphMcpServerBuilder {
        PoneglyphMcpServerBuilder::default()
    }

    pub fn router(&self) -> axum::Router {
        rmcp_http::router(self.clone())
    }

    pub fn list_tools(&self) -> Vec<Tool> {
        let mut tools = vec![tool(
            TOOL_GET_SCHEMA,
            GET_SCHEMA_TOOL_DESCRIPTION,
            json_schema_for::<GetSchemaInput>(),
        )];
        if self.agent_handler.is_some() {
            tools.push(tool(
                TOOL_MESSAGE_AGENT,
                MESSAGE_AGENT_DESCRIPTION,
                json_schema_for::<MessageAgentInput>(),
            ));
        }
        tools
    }

    pub async fn call_tool(&self, call: ToolCall) -> Result<CallToolResult> {
        debug!(component = "poneglyph_mcp", tool = %call.name, "dispatching mcp tool");
        match call.name.as_str() {
            TOOL_CREATE_ENTITY => {
                let result = self.handle_create_entity(call.arguments).await?;
                let content =
                    serde_json::to_value(result).map_err(|e| Error::InvalidToolCallResult(e))?;
                Ok(CallToolResult { content })
            }
            TOOL_STATE_FACTS => self.handle_state_facts(call.arguments).await,
            TOOL_QUERY => self.handle_query(call.arguments).await,
            TOOL_GET_SCHEMA => self.handle_get_schema(call.arguments).await,
            TOOL_GET_ENTITY => self.handle_get_entity(call.arguments).await,
            TOOL_SEARCH => self.handle_search(call.arguments).await,
            TOOL_MESSAGE_AGENT => self.handle_message_agent(call.arguments).await,
            _ => Err(Error::UnknownTool { name: call.name }),
        }
    }

    async fn handle_create_entity(&self, arguments: Value) -> Result<CreateEntityOutput> {
        let input: CreateEntityInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_CREATE_ENTITY,
                source,
            })?;
        let entity_uri = uri!(input.namespace.as_str(), input.kind.as_str());
        let facts = vec![
            // TODO(@leostera): the source here is hardcoded to mcp but it should come from
            // the context of the request!
            fact!(
                uri!("mcp:test"),
                entity_uri.clone(),
                uri!("schema:name"),
                poneglyph::Value::text(input.name)
            ),
        ];
        let tx_id = self.poneglyph.state_facts(facts).await?;
        debug!(%tx_id, "mcp state_facts succeeded");
        Ok(CreateEntityOutput { tx_id, entity_uri })
    }

    async fn handle_state_facts(&self, arguments: Value) -> Result<CallToolResult> {
        let input: StateFactsInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_STATE_FACTS,
                source,
            })?;

        let entities: HashSet<Uri> = input
            .entities
            .into_iter()
            .map(Uri::parse)
            .collect::<poneglyph::PoneResult<HashSet<_>>>()?;

        let facts: Vec<Fact> = input
            .facts
            .into_iter()
            .map(TryInto::try_into)
            .collect::<poneglyph::PoneResult<Vec<_>>>()?;

        for fact in &facts {
            if !entities.contains(&fact.entity) {
                return Err(Error::StatingFactsOfUnknownEntities { fact: fact.clone() });
            }
        }

        let tx_id = self.poneglyph.state_facts(facts).await?;
        debug!(%tx_id, "mcp state_facts succeeded");
        Ok(CallToolResult {
            content: json!({ "txId": tx_id }),
        })
    }

    async fn handle_query(&self, arguments: Value) -> Result<CallToolResult> {
        let input: QueryInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_QUERY,
                source,
            })?;
        let result = self.poneglyph.query(Query::parse(&input.query)?).await?;
        let content = serde_json::to_value(QueryOutput {
            substitutions: result.into_substitutions(),
        })
        .map_err(|source| Error::InvalidToolOutput {
            tool: TOOL_QUERY,
            source,
        })?;
        Ok(CallToolResult { content })
    }

    async fn handle_get_schema(&self, arguments: Value) -> Result<CallToolResult> {
        let _: GetSchemaInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_GET_SCHEMA,
                source,
            })?;
        let schema = self.poneglyph.get_schema().await?;
        let content = serde_json::to_value(GetSchemaOutput { schema }).map_err(|source| {
            Error::InvalidToolOutput {
                tool: TOOL_GET_SCHEMA,
                source,
            }
        })?;
        Ok(CallToolResult { content })
    }

    async fn handle_get_entity(&self, arguments: Value) -> Result<CallToolResult> {
        let input: GetEntityInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_GET_ENTITY,
                source,
            })?;
        let entity_uri = Uri::parse(input.entity_uri)?;
        let entity = self.poneglyph.get_entity(&entity_uri).await?;
        let content = serde_json::to_value(GetEntityOutput { entity }).map_err(|source| {
            Error::InvalidToolOutput {
                tool: TOOL_GET_ENTITY,
                source,
            }
        })?;
        Ok(CallToolResult { content })
    }

    async fn handle_search(&self, arguments: Value) -> Result<CallToolResult> {
        let input: SearchInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_SEARCH,
                source,
            })?;
        let hits = self
            .poneglyph
            .search(&input.query, input.limit.unwrap_or(10))?
            .into_iter()
            .map(SearchHitOutput::from)
            .collect();
        let content = serde_json::to_value(SearchOutput { hits }).map_err(|source| {
            Error::InvalidToolOutput {
                tool: TOOL_SEARCH,
                source,
            }
        })?;
        Ok(CallToolResult { content })
    }

    async fn handle_message_agent(&self, arguments: Value) -> Result<CallToolResult> {
        let input: MessageAgentInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_MESSAGE_AGENT,
                source,
            })?;
        let handler = self
            .agent_handler
            .as_ref()
            .ok_or(Error::MissingAgentHandler)?;
        let response = handler
            .send_message(AgentMessageRequest {
                message: input.message,
                session_id: input.session_id,
                source: "mcp".to_string(),
            })
            .await
            .map_err(Error::AgentMessage)?;
        let content =
            serde_json::to_value(response).map_err(|source| Error::InvalidToolOutput {
                tool: TOOL_MESSAGE_AGENT,
                source,
            })?;
        Ok(CallToolResult { content })
    }
}

impl PoneglyphMcpServerBuilder {
    pub fn with_poneglyph(self, poneglyph: Poneglyph) -> Self {
        self.poneglyph(Arc::new(poneglyph))
    }

    pub fn with_poneglyph_arc(self, poneglyph: Arc<Poneglyph>) -> Self {
        self.poneglyph(poneglyph)
    }

    pub fn with_agent_handler(self, agent_handler: Arc<dyn AgentMessageHandler>) -> Self {
        self.agent_handler(Some(agent_handler))
    }

    pub fn build(self) -> Result<PoneglyphMcpServer> {
        self.fallible_build()
            .map_err(|_| Error::MissingServerPoneglyph)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StateFactsInput {
    #[schemars(length(min = 1))]
    entities: Vec<String>,
    #[schemars(length(min = 1))]
    facts: Vec<McpFactInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct McpFactInput {
    source: Option<String>,
    entity: String,
    field: String,
    value: McpValueInput,
    #[serde(default)]
    retraction: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
enum McpValueInput {
    Null,
    Text(String),
    Number(String),
    Boolean(bool),
    Bytes(Vec<u8>),
    Reference(String),
    Date(#[schemars(with = "String")] chrono::NaiveDate),
    DateTime(#[schemars(with = "String")] chrono::DateTime<chrono::Utc>),
    List(Vec<McpValueInput>),
    Map(std::collections::BTreeMap<String, McpValueInput>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct QueryInput {
    #[schemars(length(min = 1))]
    query: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct QueryOutput {
    substitutions: Vec<datafox::Substitution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(deny_unknown_fields)]
struct GetSchemaInput {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
struct GetSchemaOutput {
    schema: poneglyph::SchemaDefinition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CreateEntityInput {
    #[schemars(length(min = 1))]
    namespace: String,
    #[schemars(length(min = 1))]
    kind: String,
    #[schemars(length(min = 1))]
    name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct CreateEntityOutput {
    #[serde(rename = "txId")]
    tx_id: Uri,
    #[serde(rename = "entityUri")]
    entity_uri: Uri,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GetEntityInput {
    #[serde(rename = "entityUri")]
    #[schemars(rename = "entityUri", length(min = 1))]
    entity_uri: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct GetEntityOutput {
    entity: Option<Entity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchInput {
    #[schemars(length(min = 1))]
    query: String,
    #[schemars(range(min = 1))]
    limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SearchOutput {
    hits: Vec<SearchHitOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MessageAgentInput {
    #[schemars(length(min = 1))]
    message: String,
    session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SearchHitOutput {
    entity_uri: String,
    score: String,
}

impl From<SearchHit> for SearchHitOutput {
    fn from(hit: SearchHit) -> Self {
        Self {
            entity_uri: hit.entity_uri.to_string(),
            score: hit.score.to_string(),
        }
    }
}

fn tool(name: &str, description: &str, input_schema: Value) -> Tool {
    Tool {
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
    }
}

fn json_schema_for<T: JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).expect("json schema")
}

impl TryFrom<McpFactInput> for Fact {
    type Error = poneglyph::Error;

    fn try_from(input: McpFactInput) -> std::result::Result<Self, Self::Error> {
        let source = match input.source {
            Some(source) => Uri::parse(source)?,
            None => poneglyph::uri!("poneglyph:internal"),
        };
        let builder = Fact::builder()
            .source(source)
            .entity(Uri::parse(input.entity)?)
            .field(Uri::parse(input.field)?)
            .value(input.value.try_into()?);
        let builder = if input.retraction {
            builder.retract()
        } else {
            builder.assert()
        };
        builder.build()
    }
}

impl TryFrom<McpValueInput> for PoneglyphValue {
    type Error = poneglyph::Error;

    fn try_from(value: McpValueInput) -> std::result::Result<Self, Self::Error> {
        Ok(match value {
            McpValueInput::Null => PoneglyphValue::Null,
            McpValueInput::Text(value) => PoneglyphValue::Text(value),
            McpValueInput::Number(value) => PoneglyphValue::Number(value),
            McpValueInput::Boolean(value) => PoneglyphValue::Boolean(value),
            McpValueInput::Bytes(value) => PoneglyphValue::Bytes(value),
            McpValueInput::Reference(value) => PoneglyphValue::Reference(Uri::parse(value)?),
            McpValueInput::Date(value) => PoneglyphValue::Date(value),
            McpValueInput::DateTime(value) => PoneglyphValue::DateTime(value),
            McpValueInput::List(values) => PoneglyphValue::List(
                values
                    .into_iter()
                    .map(TryInto::try_into)
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            ),
            McpValueInput::Map(values) => PoneglyphValue::Map(
                values
                    .into_iter()
                    .map(|(key, value)| value.try_into().map(|value| (key, value)))
                    .collect::<std::result::Result<_, _>>()?,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use tempfile::{TempDir, tempdir};
    use tokio::task::JoinHandle;

    use super::{
        AgentMessageHandler, AgentMessageRequest, AgentMessageResponse, GetSchemaOutput,
        PoneglyphMcpServer, TOOL_GET_SCHEMA, TOOL_MESSAGE_AGENT, ToolCall, json_schema_for,
    };
    use poneglyph::{Poneglyph, Workspace};

    struct TestServer {
        _tempdir: TempDir,
        server: PoneglyphMcpServer,
        runtime_task: JoinHandle<poneglyph::PoneResult<()>>,
    }

    async fn build_server() -> poneglyph::PoneResult<TestServer> {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Arc::new(
            Poneglyph::builder()
                .with_workspace(workspace)
                .build()
                .await?,
        );
        let runtime_task = tokio::spawn(runtime.clone().run());
        let server = PoneglyphMcpServer::builder()
            .with_poneglyph_arc(runtime)
            .build()
            .expect("server");
        Ok(TestServer {
            _tempdir: tempdir,
            server,
            runtime_task,
        })
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.runtime_task.abort();
        }
    }

    struct StubAgentHandler;

    #[async_trait::async_trait]
    impl AgentMessageHandler for StubAgentHandler {
        async fn send_message(
            &self,
            request: AgentMessageRequest,
        ) -> std::result::Result<AgentMessageResponse, String> {
            Ok(AgentMessageResponse {
                session_id: request
                    .session_id
                    .unwrap_or_else(|| "stub-session".to_string()),
                run_id: "stub-run".to_string(),
                reply: format!("echo: {}", request.message),
            })
        }
    }

    #[tokio::test]
    async fn server_lists_only_schema_tool_without_agent_handler() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        let tools = server.list_tools();
        let names = tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names.len(), 1);
        assert!(names.contains(&TOOL_GET_SCHEMA));
    }

    #[tokio::test]
    async fn server_lists_schema_and_agent_tools_when_handler_is_present() {
        let test_server = build_server().await.expect("server");
        let server = PoneglyphMcpServer::builder()
            .with_poneglyph_arc(test_server.server.poneglyph.clone())
            .with_agent_handler(Arc::new(StubAgentHandler))
            .build()
            .expect("server");

        let names = server
            .list_tools()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();

        assert_eq!(names.len(), 2);
        assert!(names.iter().any(|name| name == TOOL_GET_SCHEMA));
        assert!(names.iter().any(|name| name == TOOL_MESSAGE_AGENT));
    }

    #[test]
    fn server_get_schema_output_schema_exposes_structured_shape() {
        let schema = json_schema_for::<GetSchemaOutput>();

        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["schema"].is_object());
        assert!(schema["$defs"]["SchemaDefinition"]["properties"]["base"].is_object());
        assert!(schema["$defs"]["SchemaDefinition"]["properties"]["fields"].is_object());
    }

    #[tokio::test]
    async fn server_get_schema_tool_returns_bootstrapped_schema() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        let result = server
            .call_tool(ToolCall {
                name: TOOL_GET_SCHEMA.to_string(),
                arguments: json!({}),
            })
            .await
            .expect("get schema");

        assert!(
            result.content["schema"]["base"]["kinds"]
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|kind| kind["uri"] == "schema:field"))
        );
    }
}
