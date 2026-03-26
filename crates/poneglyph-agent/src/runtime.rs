use std::sync::Arc;

use agents::provider::openai::{OpenAI, OpenAIConfig};
use agents::{AgentError, AgentEvent, AgentInput, ContextManager, LlmRunner, SessionAgent};
use anyhow::Result;
use poneglyph::Poneglyph;
use serde::{Deserialize, Serialize};

use crate::tool::{PoneglyphTool, PoneglyphToolRunner};

const SYSTEM_PROMPT: &str = r#"You are poneglyph-agent, the built-in expert operator for the Poneglyph knowledge graph.

Operating rules:
- Prefer schema and graph tools over unsupported assumptions.
- For read/query tasks, inspect `get_schema` before the first graph query in a conversation.
- Build queries only from schema field URIs that actually exist in the graph. Do not invent helper predicates or namespace-specific shortcuts.
- If a graph query fails to parse or returns an unexpected shape, correct the query or inspect schema again. Do not answer from world knowledge when the graph lookup failed.
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
        let inner = SessionAgent::builder()
            .with_llm_runner(llm_runner)
            .with_tool_runner(PoneglyphToolRunner::new(poneglyph))
            .with_context_manager(ContextManager::static_text(SYSTEM_PROMPT))
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
