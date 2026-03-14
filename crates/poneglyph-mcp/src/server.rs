use std::collections::HashSet;
use std::sync::Arc;

use derive_builder::Builder;
use poneglyph::{
    Entity, Fact, Poneglyph, Query, SearchHit, Uri, Value as PoneglyphValue, fact, uri,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::{debug, instrument};

use crate::config::default_bind_addr;
use crate::error::{Error, Result};
use crate::rmcp_http::RmcpServer;
use crate::tool::{CallToolResult, Tool, ToolCall};

const TOOL_STATE_FACTS: &str = "stateFacts";
const TOOL_CREATE_ENTITY: &str = "createEntity";
const TOOL_QUERY: &str = "query";
const TOOL_GET_SCHEMA: &str = "getSchema";
const TOOL_GET_ENTITY: &str = "getEntity";
const TOOL_SEARCH: &str = "search";
const CREATE_ENTITY_DESCRIPTION: &str = r#"Create a new entity URI and immediately state its `schema:name`.

Example:
{
  "namespace": "dev",
  "kind": "project",
  "name": "poneglyph"
}

Returns:
{
  "entityUri": "dev:project:032HJb6y7SlDSWhok7W2QC",
  "txId": "poneglyph:tx:..."
}"#;
const STATE_FACTS_DESCRIPTION: &str = r#"Append one atomic batch of facts.

All entity URIs used by `facts[*].entity` must also appear in `entities`.
Use `getSchema` first when you need to discover or extend the graph vocabulary.
Use `createEntity` or `search` to find/create entities before writing facts.

Example:
{
  "entities": ["spotify:artist:rush"],
  "facts": [
    {
      "entity": "spotify:artist:rush",
      "field": "spotify:displayName",
      "value": { "type": "text", "value": "Rush" }
    }
  ]
}"#;
const QUERY_DESCRIPTION: &str = r#"Run a Datalog query over the active graph.

Supported grammar:
query        = clause , { "," , clause } ;
clause       = [ "!" ] , predicate , "(" , term , { "," , term } , ")" ;
predicate    = identifier | quoted_predicate ;
identifier   = ? unquoted predicate like spotify:displayName ? ;
quoted_predicate = "'" , { character } , "'" | '"' , { character } , '"' ;
term         = variable | "_" | string | integer ;
variable     = ? identifier starting with uppercase letter ? ;

Examples:
spotify:displayName(Album, "2112")
spotify:byArtist(Album, Artist), spotify:displayName(Artist, "Rush")
'local://schema/name'(Entity, Name)"#;

const GET_SCHEMA_DESCRIPTION: &str = r#"Fetch the effective schema definition built from ordinary schema facts and observed data.

Use this before querying or writing new schema so you can discover:
- namespaces
- kinds
- fields
- field domains, ranges, and value types when available

Example:
{}"#;
const GET_ENTITY_DESCRIPTION: &str = r#"Fetch a consolidated entity by URI.

Example:
{
  "entityUri": "spotify:artist:rush"
}"#;
const SEARCH_DESCRIPTION: &str = r#"Search the projected entity index.

Example:
{
  "query": "rush",
  "limit": 5
}"#;

#[derive(Clone, Builder)]
#[builder(pattern = "owned", build_fn(private, name = "fallible_build"))]
pub struct PoneglyphMcpServer {
    poneglyph: Arc<Poneglyph>,
    #[builder(default = "default_bind_addr()")]
    bind_addr: String,
}

impl PoneglyphMcpServer {
    pub fn builder() -> PoneglyphMcpServerBuilder {
        PoneglyphMcpServerBuilder::default()
    }

    pub async fn run(self) -> Result<()> {
        RmcpServer::new(self).run().await
    }

    pub fn bind_addr(&self) -> &str {
        &self.bind_addr
    }

    pub fn list_tools(&self) -> Vec<Tool> {
        vec![
            tool(
                TOOL_CREATE_ENTITY,
                CREATE_ENTITY_DESCRIPTION,
                json_schema_for::<CreateEntityInput>(),
            ),
            tool(
                TOOL_STATE_FACTS,
                STATE_FACTS_DESCRIPTION,
                json_schema_for::<StateFactsInput>(),
            ),
            tool(
                TOOL_QUERY,
                QUERY_DESCRIPTION,
                json_schema_for::<QueryInput>(),
            ),
            tool(
                TOOL_GET_SCHEMA,
                GET_SCHEMA_DESCRIPTION,
                json_schema_for::<GetSchemaInput>(),
            ),
            tool(
                TOOL_GET_ENTITY,
                GET_ENTITY_DESCRIPTION,
                json_schema_for::<GetEntityInput>(),
            ),
            tool(
                TOOL_SEARCH,
                SEARCH_DESCRIPTION,
                json_schema_for::<SearchInput>(),
            ),
        ]
    }

    #[instrument(skip(self, call), fields(component = "poneglyph_mcp", tool = %call.name))]
    pub async fn call_tool(&self, call: ToolCall) -> Result<CallToolResult> {
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
        let tx_id = self.poneglyph.state_facts(fact_stream(facts)).await?;
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

        let tx_id = self.poneglyph.state_facts(fact_stream(facts)).await?;
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
}

impl PoneglyphMcpServerBuilder {
    pub fn with_poneglyph(self, poneglyph: Poneglyph) -> Self {
        self.poneglyph(Arc::new(poneglyph))
    }

    pub fn with_poneglyph_arc(self, poneglyph: Arc<Poneglyph>) -> Self {
        self.poneglyph(poneglyph)
    }

    pub fn with_bind_addr(self, bind_addr: impl Into<String>) -> Self {
        self.bind_addr(bind_addr.into())
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

fn fact_stream(facts: Vec<Fact>) -> mpsc::Receiver<Fact> {
    let (tx, rx) = mpsc::channel(facts.len().max(1));
    tokio::spawn(async move {
        for fact in facts {
            if tx.send(fact).await.is_err() {
                break;
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use tempfile::{TempDir, tempdir};
    use tokio::task::JoinHandle;
    use tokio::task::yield_now;
    use tokio::time::{Duration, timeout};

    use super::{
        GetSchemaOutput, PoneglyphMcpServer, TOOL_GET_ENTITY, TOOL_GET_SCHEMA, TOOL_QUERY,
        TOOL_SEARCH, TOOL_STATE_FACTS, ToolCall, json_schema_for,
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

    async fn wait_for_entity(server: &PoneglyphMcpServer, entity_uri: &str) -> serde_json::Value {
        timeout(Duration::from_secs(1), async {
            loop {
                let result = server
                    .call_tool(ToolCall {
                        name: TOOL_GET_ENTITY.to_string(),
                        arguments: json!({ "entityUri": entity_uri }),
                    })
                    .await
                    .expect("get entity");
                if result.content["entity"].is_object() {
                    return result.content;
                }
                yield_now().await;
            }
        })
        .await
        .expect("entity eventually materializes")
    }

    async fn wait_for_search_hit(server: &PoneglyphMcpServer, query: &str) -> serde_json::Value {
        timeout(Duration::from_secs(1), async {
            loop {
                let result = server
                    .call_tool(ToolCall {
                        name: TOOL_SEARCH.to_string(),
                        arguments: json!({ "query": query, "limit": 5 }),
                    })
                    .await
                    .expect("search");
                if result.content["hits"]
                    .as_array()
                    .is_some_and(|hits| !hits.is_empty())
                {
                    return result.content;
                }
                yield_now().await;
            }
        })
        .await
        .expect("search eventually finds hit")
    }

    fn text_fact(entity: &str, field: &str, value: &str) -> serde_json::Value {
        json!({
            "entity": entity,
            "field": field,
            "value": {
                "type": "text",
                "value": value,
            }
        })
    }

    fn state_facts_args(entities: &[&str], facts: Vec<serde_json::Value>) -> serde_json::Value {
        json!({
            "entities": entities,
            "facts": facts,
        })
    }

    #[tokio::test]
    async fn server_lists_expected_tools() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        let tools = server.list_tools();
        let names = tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();

        assert!(names.contains(&TOOL_STATE_FACTS));
        assert!(names.contains(&TOOL_QUERY));
        assert!(names.contains(&TOOL_GET_SCHEMA));
        assert!(names.contains(&TOOL_GET_ENTITY));
        assert!(names.contains(&TOOL_SEARCH));
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

    #[tokio::test]
    async fn server_get_schema_tool_infers_observed_schema_from_data() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        server
            .call_tool(ToolCall {
                name: TOOL_STATE_FACTS.to_string(),
                arguments: state_facts_args(
                    &["spotify:artist:rush"],
                    vec![text_fact(
                        "spotify:artist:rush",
                        "spotify:displayName",
                        "Rush",
                    )],
                ),
            })
            .await
            .expect("state facts");

        let result = server
            .call_tool(ToolCall {
                name: TOOL_GET_SCHEMA.to_string(),
                arguments: json!({}),
            })
            .await
            .expect("get schema");

        assert!(
            result.content["schema"]["kinds"]
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|kind| kind["uri"] == "spotify:artist"))
        );
        assert!(
            result.content["schema"]["fields"]
                .as_array()
                .is_some_and(|fields| fields
                    .iter()
                    .any(|field| field["uri"] == "spotify:displayName"))
        );
    }

    #[tokio::test]
    async fn server_state_facts_tool_schema_uses_wire_fact_shape() {
        let test_server = build_server().await.expect("server");
        let tool = test_server
            .server
            .list_tools()
            .into_iter()
            .find(|tool| tool.name == TOOL_STATE_FACTS)
            .expect("state facts tool");

        let item_ref = tool.input_schema["properties"]["facts"]["items"]["$ref"]
            .as_str()
            .expect("fact schema ref");
        let definition_name = item_ref.strip_prefix("#/$defs/").expect("defs ref");
        let item_properties = &tool.input_schema["$defs"][definition_name]["properties"];

        assert!(item_properties.get("fact_id").is_none());
        assert!(item_properties.get("stated_at").is_none());
        assert!(item_properties.get("tx_id").is_none());
        assert!(item_properties.get("entity").is_some());
        assert!(item_properties.get("field").is_some());
        assert!(item_properties.get("value").is_some());
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
    async fn server_state_facts_tool_returns_tx_id() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        let result = server
            .call_tool(ToolCall {
                name: TOOL_STATE_FACTS.to_string(),
                arguments: state_facts_args(
                    &["spotify:album:2112"],
                    vec![text_fact(
                        "spotify:album:2112",
                        "spotify:displayName",
                        "2112",
                    )],
                ),
            })
            .await
            .expect("state facts");

        assert!(result.content["txId"].as_str().is_some());
    }

    #[tokio::test]
    async fn server_query_tool_returns_substitutions() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        server
            .call_tool(ToolCall {
                name: TOOL_STATE_FACTS.to_string(),
                arguments: state_facts_args(
                    &["spotify:album:2112"],
                    vec![text_fact(
                        "spotify:album:2112",
                        "spotify:displayName",
                        "2112",
                    )],
                ),
            })
            .await
            .expect("state facts");

        let result = server
            .call_tool(ToolCall {
                name: TOOL_QUERY.to_string(),
                arguments: json!({
                    "query": r#"spotify:displayName(Album, "2112")"#
                }),
            })
            .await
            .expect("query");

        assert_eq!(
            result.content["substitutions"].as_array().map(Vec::len),
            Some(1)
        );
    }

    #[tokio::test]
    async fn server_get_entity_tool_reads_materialized_entities() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;
        let entity_uri = "spotify:album:signals";

        server
            .call_tool(ToolCall {
                name: TOOL_STATE_FACTS.to_string(),
                arguments: state_facts_args(
                    &[entity_uri],
                    vec![text_fact(entity_uri, "spotify:displayName", "Signals")],
                ),
            })
            .await
            .expect("state facts");

        let result = wait_for_entity(&server, entity_uri).await;

        assert_eq!(result["entity"]["uri"], json!(entity_uri));
        assert_eq!(
            result["entity"]["fields"]["spotify:displayName"],
            json!({
                "type": "text",
                "value": "Signals"
            })
        );
    }

    #[tokio::test]
    async fn server_search_tool_reads_projected_index() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        server
            .call_tool(ToolCall {
                name: TOOL_STATE_FACTS.to_string(),
                arguments: state_facts_args(
                    &["spotify:album:grace-under-pressure"],
                    vec![text_fact(
                        "spotify:album:grace-under-pressure",
                        "spotify:displayName",
                        "Grace Under Pressure",
                    )],
                ),
            })
            .await
            .expect("state facts");

        let result = wait_for_search_hit(&server, "Grace").await;
        let first_hit = &result["hits"][0];
        assert_eq!(
            first_hit["entity_uri"],
            json!("spotify:album:grace-under-pressure")
        );
    }
}
