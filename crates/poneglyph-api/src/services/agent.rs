use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use poneglyph::Poneglyph;
use poneglyph_agent::{OpenAiProviderConfig, PoneglyphAgent, PoneglyphAgentEvent};
use poneglyph_ctl::{
    AgentAuditEvent, AgentAuditRun, AiProviderConfig, CtlStore, SaveAiProviderConfig,
};
use poneglyph_mcp::{AgentMessageHandler, AgentMessageRequest, AgentMessageResponse};
use serde_json::{Value as JsonValue, json};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) struct AiProviderSummary {
    pub id: i64,
    pub provider_key: String,
    pub display_name: String,
    pub base_url: String,
    pub default_model: String,
    pub enabled: bool,
    pub has_api_key: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SaveAiProviderInput {
    pub provider_key: String,
    pub display_name: String,
    pub base_url: String,
    pub default_model: String,
    pub api_key: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentChatReply {
    pub session_id: String,
    pub run_id: String,
    pub reply: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentAuditRunSummary {
    pub id: String,
    pub agent_key: String,
    pub session_id: Option<String>,
    pub source: String,
    pub status: String,
    pub input_summary: Option<String>,
    pub reply_summary: Option<String>,
    pub error_summary: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentAuditEventRecord {
    pub id: String,
    pub run_id: String,
    pub seq: i64,
    pub event_type: String,
    pub payload_json: String,
    pub occurred_at: String,
}

#[derive(Clone)]
pub(crate) struct AgentService {
    poneglyph: Arc<Poneglyph>,
    ctl: CtlStore,
    sessions: Arc<Mutex<HashMap<String, Arc<AgentSession>>>>,
}

struct AgentSession {
    agent: Mutex<PoneglyphAgent>,
}

impl AgentService {
    pub(crate) fn new(poneglyph: Arc<Poneglyph>, ctl: CtlStore) -> Self {
        Self {
            poneglyph,
            ctl,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn list_ai_providers(&self) -> Result<Vec<AiProviderSummary>, String> {
        self.ctl
            .list_ai_provider_configs()
            .await
            .map(|providers| providers.into_iter().map(map_ai_provider).collect())
            .map_err(|error| format!("failed to list ai providers: {error}"))
    }

    pub(crate) async fn save_ai_provider(
        &self,
        input: SaveAiProviderInput,
    ) -> Result<AiProviderSummary, String> {
        let existing = self
            .ctl
            .ai_provider_config_by_key(input.provider_key.as_str())
            .await
            .map_err(|error| format!("failed to load existing ai provider: {error}"))?;
        let api_key = if input.api_key.trim().is_empty() {
            existing
                .as_ref()
                .map(|provider| provider.api_key.clone())
                .unwrap_or_default()
        } else {
            input.api_key
        };
        self.ctl
            .save_ai_provider_config(SaveAiProviderConfig {
                provider_key: input.provider_key,
                display_name: input.display_name,
                base_url: input.base_url,
                default_model: input.default_model,
                api_key,
                enabled: input.enabled,
            })
            .await
            .map(map_ai_provider)
            .map_err(|error| format!("failed to save ai provider: {error}"))
    }

    pub(crate) async fn delete_ai_provider(&self, id: i64) -> Result<bool, String> {
        self.ctl
            .delete_ai_provider_config(id)
            .await
            .map_err(|error| format!("failed to delete ai provider: {error}"))
    }

    pub(crate) async fn send_message(
        &self,
        message: String,
        session_id: Option<String>,
        source: &str,
    ) -> Result<AgentChatReply, String> {
        let session_id = session_id.unwrap_or_else(|| Uuid::now_v7().to_string());
        let session = self.session(session_id.as_str()).await?;
        let run_id = Uuid::now_v7().to_string();
        let started_at = Utc::now();
        let seq_counter = Arc::new(Mutex::new(1_i64));

        self.ctl
            .create_agent_audit_run(&AgentAuditRun {
                id: run_id.clone(),
                agent_key: "poneglyph-agent".to_string(),
                session_id: Some(session_id.clone()),
                source: source.to_string(),
                status: "running".to_string(),
                input_summary: Some(summarize_text(&message)),
                reply_summary: None,
                error_summary: None,
                started_at,
                finished_at: None,
            })
            .await
            .map_err(|error| format!("failed to create audit run: {error}"))?;

        self.append_audit_event(
            run_id.as_str(),
            next_audit_seq(&seq_counter).await,
            "input_received",
            json!({ "message": redact_json(json!(message.clone())) }),
        )
        .await?;

        let mut agent = session.agent.lock().await;
        let result = agent
            .run_turn_observed(message, |event| {
                let service = self.clone();
                let run_id = run_id.clone();
                let seq_counter = seq_counter.clone();
                async move {
                    let payload = event_payload(&event);
                    let event_type = event_type(&event);
                    service
                        .append_audit_event(
                            run_id.as_str(),
                            next_audit_seq(&seq_counter).await,
                            event_type,
                            payload,
                        )
                        .await
                        .map_err(anyhow::Error::msg)
                }
            })
            .await;

        match result {
            Ok(reply) => {
                self.ctl
                    .finish_agent_audit_run(
                        run_id.as_str(),
                        "succeeded",
                        Some(summarize_text(&reply).as_str()),
                        None,
                    )
                    .await
                    .map_err(|error| format!("failed to finish audit run: {error}"))?;

                Ok(AgentChatReply {
                    session_id,
                    run_id,
                    reply,
                })
            }
            Err(error) => {
                self.append_audit_event(
                    run_id.as_str(),
                    next_audit_seq(&seq_counter).await,
                    "run_failed",
                    json!({ "error": redact_json(json!(error.to_string())) }),
                )
                .await?;
                self.ctl
                    .finish_agent_audit_run(
                        run_id.as_str(),
                        "failed",
                        None,
                        Some(error.to_string().as_str()),
                    )
                    .await
                    .map_err(|finish_error| {
                        format!("failed to finish failed audit run: {finish_error}")
                    })?;
                Err(format!("poneglyph-agent failed: {error}"))
            }
        }
    }

    pub(crate) async fn list_audit_runs(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<AgentAuditRunSummary>, String> {
        self.ctl
            .list_agent_audit_runs(limit, offset)
            .await
            .map(|runs| runs.into_iter().map(map_audit_run).collect())
            .map_err(|error| format!("failed to list audit runs: {error}"))
    }

    pub(crate) async fn list_audit_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<AgentAuditEventRecord>, String> {
        self.ctl
            .agent_audit_events(run_id)
            .await
            .map(|events| events.into_iter().map(map_audit_event).collect())
            .map_err(|error| format!("failed to list audit events: {error}"))
    }

    async fn session(&self, session_id: &str) -> Result<Arc<AgentSession>, String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(session_id) {
            return Ok(session.clone());
        }

        let provider = self
            .ctl
            .enabled_ai_provider_config()
            .await
            .map_err(|error| format!("failed to load ai provider: {error}"))?
            .ok_or_else(|| {
                "No AI provider configured. Open Settings and connect ChatGPT/OpenAI first."
                    .to_string()
            })?;

        let session = Arc::new(AgentSession {
            agent: Mutex::new(
                PoneglyphAgent::new(self.poneglyph.clone(), &map_openai_provider(&provider))
                    .map_err(|error| format!("failed to initialize poneglyph-agent: {error}"))?,
            ),
        });
        sessions.insert(session_id.to_string(), session.clone());
        Ok(session)
    }

    async fn append_audit_event(
        &self,
        run_id: &str,
        seq: i64,
        event_type: &str,
        payload: JsonValue,
    ) -> Result<(), String> {
        self.ctl
            .append_agent_audit_event(&AgentAuditEvent {
                id: Uuid::now_v7().to_string(),
                run_id: run_id.to_string(),
                seq,
                event_type: event_type.to_string(),
                payload: redact_json(payload),
                occurred_at: Utc::now(),
            })
            .await
            .map_err(|error| format!("failed to append audit event: {error}"))?;
        Ok(())
    }
}

#[async_trait]
impl AgentMessageHandler for AgentService {
    async fn send_message(
        &self,
        request: AgentMessageRequest,
    ) -> std::result::Result<AgentMessageResponse, String> {
        self.send_message(request.message, request.session_id, request.source.as_str())
            .await
            .map(|reply| AgentMessageResponse {
                session_id: reply.session_id,
                run_id: reply.run_id,
                reply: reply.reply,
            })
    }
}

fn map_ai_provider(provider: AiProviderConfig) -> AiProviderSummary {
    AiProviderSummary {
        id: provider.id,
        provider_key: provider.provider_key,
        display_name: provider.display_name,
        base_url: provider.base_url,
        default_model: provider.default_model,
        enabled: provider.enabled,
        has_api_key: !provider.api_key.is_empty(),
    }
}

fn map_openai_provider(provider: &AiProviderConfig) -> OpenAiProviderConfig {
    OpenAiProviderConfig {
        api_key: provider.api_key.clone(),
        base_url: provider.base_url.clone(),
        default_model: provider.default_model.clone(),
    }
}

fn map_audit_run(run: AgentAuditRun) -> AgentAuditRunSummary {
    AgentAuditRunSummary {
        id: run.id,
        agent_key: run.agent_key,
        session_id: run.session_id,
        source: run.source,
        status: run.status,
        input_summary: run.input_summary,
        reply_summary: run.reply_summary,
        error_summary: run.error_summary,
        started_at: run.started_at.to_rfc3339(),
        finished_at: run.finished_at.map(|value| value.to_rfc3339()),
    }
}

fn map_audit_event(event: AgentAuditEvent) -> AgentAuditEventRecord {
    AgentAuditEventRecord {
        id: event.id,
        run_id: event.run_id,
        seq: event.seq,
        event_type: event.event_type,
        payload_json: serde_json::to_string_pretty(&event.payload)
            .unwrap_or_else(|_| "{}".to_string()),
        occurred_at: event.occurred_at.to_rfc3339(),
    }
}

fn event_type(event: &PoneglyphAgentEvent) -> &'static str {
    match event {
        PoneglyphAgentEvent::ContextWindowMaterialized { .. } => "context_window_materialized",
        PoneglyphAgentEvent::RequestPrepared { .. } => "request_prepared",
        PoneglyphAgentEvent::ModelOutputItem { .. } => "model_output_item",
        PoneglyphAgentEvent::ToolCallRequested { .. } => "tool_call_requested",
        PoneglyphAgentEvent::ToolExecutionCompleted { .. } => "tool_execution_completed",
        PoneglyphAgentEvent::Completed { .. } => "completed",
        PoneglyphAgentEvent::Cancelled => "cancelled",
    }
}

fn event_payload(event: &PoneglyphAgentEvent) -> JsonValue {
    match event {
        PoneglyphAgentEvent::ContextWindowMaterialized { window } => json!({
            "chunks": window.chunks.len(),
        }),
        PoneglyphAgentEvent::RequestPrepared { request } => json!({
            "model": request.model,
            "inputItems": request.input_items,
        }),
        PoneglyphAgentEvent::ModelOutputItem { item, .. } => json!({
            "item": item,
        }),
        PoneglyphAgentEvent::ToolCallRequested { call, .. } => json!({
            "callId": call.call_id,
            "name": call.name,
            "arguments": call.arguments,
        }),
        PoneglyphAgentEvent::ToolExecutionCompleted { result } => json!({
            "callId": result.call_id,
            "result": result,
        }),
        PoneglyphAgentEvent::Completed { reply, .. } => json!({
            "reply": reply,
        }),
        PoneglyphAgentEvent::Cancelled => json!({}),
    }
}

fn summarize_text(text: &str) -> String {
    const LIMIT: usize = 180;
    let trimmed = text.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }

    let mut summary = trimmed.chars().take(LIMIT).collect::<String>();
    summary.push_str("...");
    summary
}

async fn next_audit_seq(counter: &Arc<Mutex<i64>>) -> i64 {
    let mut seq = counter.lock().await;
    let current = *seq;
    *seq += 1;
    current
}

fn redact_json(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Object(object) => JsonValue::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    let redacted = [
                        "token",
                        "secret",
                        "authorization",
                        "password",
                        "api_key",
                        "refresh_token",
                        "access_token",
                    ]
                    .iter()
                    .any(|needle| lower.contains(needle));
                    if redacted {
                        (key, JsonValue::String("[REDACTED]".to_string()))
                    } else {
                        (key, redact_json(value))
                    }
                })
                .collect(),
        ),
        JsonValue::Array(values) => JsonValue::Array(values.into_iter().map(redact_json).collect()),
        other => other,
    }
}
