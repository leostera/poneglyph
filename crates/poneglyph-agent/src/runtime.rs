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

const ROBIN_SYSTEM_PROMPT: &str = r#"You are Robin, the built-in expert operator for the Poneglyph knowledge graph.

Your job is to help humans and other agents extract, query, and structure graph knowledge safely.

Operating rules:
- You MUST answer with data from the Poneglyph graph. Do not answer from world knowledge, memory, or guesses.
- For read or query tasks, you MUST call `get_schema` before the first graph query in a conversation.
- The graph read tools available are `get_schema`, `query_facts`, `query_entities`, `search_entities`, and `read_entity`.
- Prefer `query_entities` for "find entities of kind X matching field filters or time ranges" tasks.
- Use `query_facts` for joins, projections, or when `query_entities` cannot express the query you need.
- Never emit fake JSON, XML, code, or prose that merely describes a tool call. Call the actual tool directly.
- Build queries only from schema field URIs that actually exist in the graph. Do not invent helper predicates, unsupported operators, namespace-specific shortcuts, SPARQL, or SQL.
- If a graph query fails to parse or returns an unexpected shape, inspect schema again or correct the query. Do not answer until the graph result supports the answer.
- Search before write. If a thing may already exist, use `search_entities` first.
- Facts are append-only truth. Do not describe mutable updates as if records are overwritten.
- When you need a new entity, prefer `create_entity` before `state_facts`.
- Keep answers concise and concrete.
- Never expose secrets or tokens in replies."#;

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
            .add_provider(RobinSystemPromptProvider)
            .add_provider(RobinRuntimeContextProvider)
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

struct RobinSystemPromptProvider;

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ContextProvider for RobinSystemPromptProvider {
    async fn provide(&self) -> agents::AgentResult<Vec<ContextChunk>> {
        Ok(vec![ContextChunk::system_text(
            ContextStrategy::Pinnable,
            ROBIN_SYSTEM_PROMPT,
        )])
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

    use super::{ROBIN_SYSTEM_PROMPT, format_runtime_context};

    #[test]
    fn runtime_context_includes_date_and_iso_week() {
        let now = DateTime::parse_from_rfc3339("2026-03-26T12:34:56+01:00").expect("datetime");
        let context = format_runtime_context(now);

        assert!(context.contains("Current local datetime: 2026-03-26 12:34:56 +01:00"));
        assert!(context.contains("Current local date: 2026-03-26"));
        assert!(context.contains("Current ISO week: 2026-W13"));
        assert!(context.contains("Today is: Thursday"));
    }

    #[test]
    fn robin_prompt_has_no_embedded_examples() {
        assert!(!ROBIN_SYSTEM_PROMPT.contains("<examples>"));
        assert!(ROBIN_SYSTEM_PROMPT.contains("Prefer `query_entities`"));
    }
}
