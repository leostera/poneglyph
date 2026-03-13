use std::sync::Arc;

use derive_builder::Builder;
use poneglyph::{Entity, Fact, Poneglyph, Query, SearchHit, Uri};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::{debug, instrument};

use crate::error::{Error, Result};
use crate::tool::{CallToolResult, Tool, ToolCall};

const TOOL_STATE_FACTS: &str = "Poneglyph-stateFacts";
const TOOL_QUERY: &str = "Poneglyph-query";
const TOOL_GET_ENTITY: &str = "Poneglyph-getEntity";
const TOOL_SEARCH: &str = "Poneglyph-search";

#[derive(Clone, Builder)]
#[builder(pattern = "owned", build_fn(private, name = "fallible_build"))]
pub struct PoneglyphMcpServer {
    poneglyph: Arc<Poneglyph>,
}

impl PoneglyphMcpServer {
    pub fn builder() -> PoneglyphMcpServerBuilder {
        PoneglyphMcpServerBuilder::default()
    }

    pub fn list_tools(&self) -> Vec<Tool> {
        vec![
            tool(
                TOOL_STATE_FACTS,
                "Append one atomic batch of facts.",
                json!({
                    "type": "object",
                    "properties": {
                        "facts": { "type": "array" }
                    },
                    "required": ["facts"]
                }),
            ),
            tool(
                TOOL_QUERY,
                "Run a Datalog query over the active graph.",
                json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }),
            ),
            tool(
                TOOL_GET_ENTITY,
                "Fetch a consolidated entity by URI.",
                json!({
                    "type": "object",
                    "properties": {
                        "entityUri": { "type": "string" }
                    },
                    "required": ["entityUri"]
                }),
            ),
            tool(
                TOOL_SEARCH,
                "Search the projected entity index.",
                json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "limit": { "type": "integer" }
                    },
                    "required": ["query"]
                }),
            ),
        ]
    }

    #[instrument(skip(self, call), fields(component = "poneglyph_mcp", tool = %call.name))]
    pub async fn call_tool(&self, call: ToolCall) -> Result<CallToolResult> {
        match call.name.as_str() {
            TOOL_STATE_FACTS => self.handle_state_facts(call.arguments).await,
            TOOL_QUERY => self.handle_query(call.arguments).await,
            TOOL_GET_ENTITY => self.handle_get_entity(call.arguments).await,
            TOOL_SEARCH => self.handle_search(call.arguments).await,
            _ => Err(Error::UnknownTool { name: call.name }),
        }
    }

    async fn handle_state_facts(&self, arguments: Value) -> Result<CallToolResult> {
        let input: StateFactsInput =
            serde_json::from_value(arguments).map_err(|source| Error::InvalidToolInput {
                tool: TOOL_STATE_FACTS,
                source,
            })?;
        let tx_id = self.poneglyph.state_facts(fact_stream(input.facts)).await?;
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

    pub fn build(self) -> Result<PoneglyphMcpServer> {
        self.fallible_build()
            .map_err(|_| Error::MissingServerPoneglyph)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct StateFactsInput {
    facts: Vec<Fact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct QueryInput {
    query: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct QueryOutput {
    substitutions: Vec<datafox::Substitution>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct GetEntityInput {
    #[serde(rename = "entityUri")]
    entity_uri: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct GetEntityOutput {
    entity: Option<Entity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SearchInput {
    query: String,
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
    use serde_json::json;
    use tempfile::{TempDir, tempdir};
    use tokio::task::yield_now;
    use tokio::time::{Duration, timeout};

    use super::{
        PoneglyphMcpServer, TOOL_GET_ENTITY, TOOL_QUERY, TOOL_SEARCH, TOOL_STATE_FACTS, ToolCall,
    };
    use poneglyph::{Poneglyph, Value, Workspace, fact, uri};

    struct TestServer {
        _tempdir: TempDir,
        server: PoneglyphMcpServer,
    }

    async fn build_server() -> poneglyph::PoneResult<TestServer> {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let runtime = Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await?;
        let server = PoneglyphMcpServer::builder()
            .with_poneglyph(runtime)
            .build()
            .expect("server");
        Ok(TestServer {
            _tempdir: tempdir,
            server,
        })
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
        assert!(names.contains(&TOOL_GET_ENTITY));
        assert!(names.contains(&TOOL_SEARCH));
    }

    #[tokio::test]
    async fn server_state_facts_tool_returns_tx_id() {
        let test_server = build_server().await.expect("server");
        let server = &test_server.server;

        let result = server
            .call_tool(ToolCall {
                name: TOOL_STATE_FACTS.to_string(),
                arguments: json!({
                    "facts": [
                        fact!(
                            uri!("spotify:album:2112"),
                            uri!("spotify:displayName"),
                            Value::text("2112")
                        )
                    ]
                }),
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
                arguments: json!({
                    "facts": [
                        fact!(
                            uri!("spotify:album:2112"),
                            uri!("spotify:displayName"),
                            Value::text("2112")
                        )
                    ]
                }),
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
                arguments: json!({
                    "facts": [
                        fact!(
                            uri!(entity_uri),
                            uri!("spotify:displayName"),
                            Value::text("Signals")
                        )
                    ]
                }),
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
                arguments: json!({
                    "facts": [
                        fact!(
                            uri!("spotify:album:grace-under-pressure"),
                            uri!("spotify:displayName"),
                            Value::text("Grace Under Pressure")
                        )
                    ]
                }),
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
