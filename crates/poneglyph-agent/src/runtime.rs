use std::sync::Arc;

use agents::agent::{ContextChunk, ContextProvider, ContextStrategy};
use agents::provider::openai::{OpenAI, OpenAIConfig};
use agents::{AgentError, AgentEvent, AgentInput, ContextManager, LlmRunner, SessionAgent};
use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Datelike, FixedOffset, Local};
use poneglyph::Poneglyph;
use serde::{Deserialize, Serialize};

use crate::tool::{PoneglyphTool, PoneglyphToolRunner};

const ROBIN_IDENTITY_PROMPT: &str = r#"You are Robin, the built-in expert operator for the Poneglyph knowledge graph.

Your job is to help humans and other agents extract, query, and structure graph knowledge safely."#;

const ROBIN_OPERATING_RULES_PROMPT: &str = r#"Operating rules:
- You MUST answer with data from the Poneglyph graph. Do not answer from world knowledge, memory, or guesses.
- For read/query tasks, you MUST call `get_schema` before the first graph query in a conversation.
- The only graph read tools available are `get_schema`, `query_facts`, `search_entities`, and `read_entity`.
- There is NO `query_entities` tool. There is NO SPARQL support. There is NO SQL support.
- Never emit fake JSON for tool calls in assistant text. Call the actual tool directly.
- Build queries only from schema field URIs that actually exist in the graph. Do not invent helper predicates or namespace-specific shortcuts.
- If a graph query fails to parse or returns an unexpected shape, inspect schema again or correct the query. Do not answer until the graph result supports the answer.
- Prefer schema and graph tools over unsupported assumptions.
- Search before write. If a thing may already exist, use search_entities first.
- Facts are append-only truth. Do not describe mutable updates as if records are overwritten.
- When you need a new entity, prefer create_entity before state_facts.
- Keep answers concise and concrete.
- Never expose secrets or tokens in replies.
"#;

pub type PoneglyphSessionAgent = SessionAgent<String, PoneglyphTool, serde_json::Value, String>;
pub type PoneglyphAgentEvent = AgentEvent<PoneglyphTool, serde_json::Value, String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiProviderConfig {
    pub api_key: String,
    pub base_url: String,
    pub default_model: String,
}

impl OpenAiProviderConfig {
    pub fn llm_runner(&self) -> Result<Arc<LlmRunner>> {
        let provider = OpenAI::new(
            OpenAIConfig::new(self.api_key.clone(), self.default_model.clone())?
                .with_base_url(self.base_url.clone()),
        );
        Ok(Arc::new(
            LlmRunner::builder().add_provider(provider).build(),
        ))
    }
}

#[derive(agents::Agent)]
pub struct PoneglyphAgent {
    #[agent]
    inner: PoneglyphSessionAgent,
}

impl PoneglyphAgent {
    pub fn new(poneglyph: Arc<Poneglyph>, provider: &OpenAiProviderConfig) -> Result<Self> {
        let llm_runner = provider.llm_runner()?;
        Self::new_with_runner(poneglyph, llm_runner)
    }

    pub fn new_with_runner(poneglyph: Arc<Poneglyph>, llm_runner: Arc<LlmRunner>) -> Result<Self> {
        let context_manager = ContextManager::builder()
            .add_provider(RobinIdentityContextProvider)
            .add_provider(RobinRuntimeContextProvider)
            .add_provider(RobinSchemaFirstExampleProvider)
            .build();
        let inner = SessionAgent::builder()
            .with_llm_runner(llm_runner)
            .with_tool_runner(PoneglyphToolRunner::new(poneglyph))
            .with_context_manager(context_manager)
            .build()?;
        Ok(Self { inner })
    }

    pub async fn run_turn_observed<F, Fut>(
        &mut self,
        input: String,
        mut observe: F,
    ) -> Result<String>
    where
        F: FnMut(PoneglyphAgentEvent) -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        self.inner.send(AgentInput::Message(input)).await?;

        loop {
            let Some(event) = self.inner.next().await? else {
                anyhow::bail!("agent ended turn without a terminal event");
            };

            observe(event.clone()).await?;

            match event {
                AgentEvent::Completed { reply, .. } => return Ok(reply),
                AgentEvent::Cancelled => return Err(AgentError::Cancelled.into()),
                _ => {}
            }
        }
    }
}

struct RobinIdentityContextProvider;

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ContextProvider for RobinIdentityContextProvider {
    async fn provide(&self) -> agents::AgentResult<Vec<ContextChunk>> {
        Ok(vec![
            ContextChunk::system_text(ContextStrategy::Pinnable, ROBIN_IDENTITY_PROMPT),
            ContextChunk::system_text(ContextStrategy::Pinnable, ROBIN_OPERATING_RULES_PROMPT),
        ])
    }
}

struct RobinRuntimeContextProvider;

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ContextProvider for RobinRuntimeContextProvider {
    async fn provide(&self) -> agents::AgentResult<Vec<ContextChunk>> {
        let now = Local::now().fixed_offset();
        Ok(vec![ContextChunk::system_text(
            ContextStrategy::Pinnable,
            format_runtime_context(now),
        )])
    }
}

struct RobinSchemaFirstExampleProvider;

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ContextProvider for RobinSchemaFirstExampleProvider {
    async fn provide(&self) -> agents::AgentResult<Vec<ContextChunk>> {
        Ok(vec![
            ContextChunk::user_text(ContextStrategy::Pinnable, "Do I have any events this week?"),
            ContextChunk::assistant_text(
                ContextStrategy::Pinnable,
                "I will inspect the schema first, then query the graph with the exact field names I find there.",
            ),
            ContextChunk::ToolCall {
                strategy: ContextStrategy::Pinnable,
                id: "example_get_schema".to_string(),
                name: "get_schema".to_string(),
                args: serde_json::json!({}),
            },
            ContextChunk::ToolResult {
                strategy: ContextStrategy::Pinnable,
                id: "example_get_schema".to_string(),
                result: serde_json::json!({
                    "kinds": [
                        { "uri": "gcal:event", "name": "Event" }
                    ],
                    "fields": [
                        { "uri": "gcal:startAt", "domain": "gcal:event", "name": "Start At" },
                        { "uri": "schema:name", "domain": null, "name": "Name" }
                    ]
                }),
            },
            ContextChunk::ToolCall {
                strategy: ContextStrategy::Pinnable,
                id: "example_query_facts".to_string(),
                name: "query_facts".to_string(),
                args: serde_json::json!({
                    "query": r#"gcal:startAt(Event, Start), Start >= "2026-03-23", Start <= "2026-03-29", schema:name(Event, Name)"#
                }),
            },
            ContextChunk::ToolResult {
                strategy: ContextStrategy::Pinnable,
                id: "example_query_facts".to_string(),
                result: serde_json::json!({
                    "substitutions": [
                        {
                            "bindings": {
                                "Event": { "String": "gcal:event:design-review" },
                                "Name": { "String": "Design Review" },
                                "Start": { "String": "2026-03-25T10:00:00+00:00" }
                            }
                        }
                    ]
                }),
            },
            ContextChunk::assistant_text(
                ContextStrategy::Pinnable,
                "Yes, you have an event this week. The event is named \"Design Review\" and starts on March 25, 2026 at 10:00 AM.",
            ),
        ])
    }
}

fn format_runtime_context(now: DateTime<FixedOffset>) -> String {
    let iso_week = now.iso_week();
    format!(
        "Runtime context:\n- Current local datetime: {}\n- Current local date: {}\n- Current ISO week: {}-W{:02}\n- Today is: {}\n- If the user asks about \"this week\", interpret that relative to the current date unless they provide explicit dates.",
        now.format("%Y-%m-%d %H:%M:%S %:z"),
        now.format("%Y-%m-%d"),
        iso_week.year(),
        iso_week.week(),
        now.format("%A"),
    )
}

#[cfg(test)]
mod tests {
    use chrono::DateTime;

    use super::format_runtime_context;

    #[test]
    fn runtime_context_includes_date_and_iso_week() {
        let now = DateTime::parse_from_rfc3339("2026-03-26T12:34:56+01:00").expect("datetime");
        let context = format_runtime_context(now);

        assert!(context.contains("Current local datetime: 2026-03-26 12:34:56 +01:00"));
        assert!(context.contains("Current local date: 2026-03-26"));
        assert!(context.contains("Current ISO week: 2026-W13"));
        assert!(context.contains("Today is: Thursday"));
    }
}
