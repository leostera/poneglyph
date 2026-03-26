use std::sync::Arc;

use anyhow::Result;
use chrono::{TimeZone, Utc};
use evals::{
    EvalContext, GradeResult, GradingConfig, RecordedEvent, Trajectory, eval, judge, predicate,
    suite, trajectory,
};
use poneglyph::{Poneglyph, Value, Workspace, fact, uri};
use tempfile::tempdir;

use crate::PoneglyphAgent;

const IN_WEEK_EVENT_NAME: &str = "Design Review";
const OUT_OF_WEEK_EVENT_NAME: &str = "Quarter Planning";
const WEEKLY_CALENDAR_PROMPT: &str = "Today is Monday, March 23, 2026. This week means March 23, 2026 through March 29, 2026, inclusive. Answer only from the Poneglyph graph. Do I have any events this week?";

#[suite(kind = "regression", agent = new_agent)]
async fn new_agent(ctx: EvalContext<()>) -> Result<PoneglyphAgent> {
    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let poneglyph = Arc::new(
        Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await?,
    );

    seed_fake_calendar_graph(&poneglyph).await?;

    PoneglyphAgent::new_with_runner(poneglyph, ctx.llm_runner())
}

#[eval(
    agent = PoneglyphAgent,
    desc = "answers weekly calendar questions from graph facts",
    tags = ["poneglyph-agent", "calendar", "gcal", "querying"],
)]
async fn answers_events_this_week(_ctx: EvalContext<()>) -> Result<Trajectory<PoneglyphAgent, ()>> {
    let answer_quality_rubric = format!(
        "Read the transcript and final reply. Grade whether the assistant correctly answered the user's question about events this week using the graph.\n\
         Score 1.0 when the answer clearly says there is an in-week event and correctly identifies `{}` as happening during March 23, 2026 through March 29, 2026, inclusive.\n\
         Score 1.0 even if the answer includes extra grounded details like the entity URI, timestamps, status, or calendar, as long as the answer remains correct.\n\
         Score 1.0 if the event name is presented in equivalent human-readable form.\n\
         Score 0.0 if the answer says there are no in-week events, fails to identify the in-week event, or incorrectly treats `{}` as being in the requested week.\n\
         Use intermediate scores only for partially correct but still materially flawed answers.",
        IN_WEEK_EVENT_NAME, OUT_OF_WEEK_EVENT_NAME,
    );

    Ok(trajectory![
        user!(WEEKLY_CALENDAR_PROMPT),
        assistant!(GradingConfig::new()
            .grader(predicate("uses-schema-then-query", |trial, _ctx| async move {
                let requested_tools = requested_tool_names(&trial.transcript);
                let schema_index =
                    requested_tools.iter().position(|name| name.as_str() == "get_schema");
                let query_index = requested_tools
                    .iter()
                    .position(|name| matches!(name.as_str(), "query_facts" | "query_entities"));

                let (score, summary) = match (schema_index, query_index) {
                    (Some(schema_index), Some(query_index)) if schema_index < query_index => (
                        1.0,
                        "agent inspected schema before issuing a graph query".to_string(),
                    ),
                    (Some(_), Some(_)) => (
                        0.0,
                        "agent queried the graph before inspecting schema".to_string(),
                    ),
                    (Some(_), None) => (
                        0.0,
                        "agent inspected schema but never queried the graph".to_string(),
                    ),
                    (None, Some(_)) => (
                        0.0,
                        "agent queried the graph without first inspecting schema".to_string(),
                    ),
                    (None, None) => (
                        0.0,
                        "agent neither inspected schema nor queried the graph".to_string(),
                    ),
                };

                Ok(GradeResult {
                    score,
                    summary,
                    evidence: serde_json::json!({
                        "requestedTools": requested_tools,
                        "toolTrace": trial.tool_trace,
                        "reply": trial.final_reply,
                    }),
                })
            }))
            .grader(judge("identifies-in-week-event", answer_quality_rubric))),
    ])
}

fn requested_tool_names(events: &[RecordedEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            RecordedEvent::ToolCallRequested { name, .. } => Some(name.clone()),
            _ => None,
        })
        .collect()
}

async fn seed_fake_calendar_graph(poneglyph: &Arc<Poneglyph>) -> Result<()> {
    let calendar = uri!("gcal:calendar:personal");
    let in_week_event = uri!("gcal:event:design-review");
    let out_of_week_event = uri!("gcal:event:quarter-planning");

    let in_week_start = Utc
        .with_ymd_and_hms(2026, 3, 25, 10, 0, 0)
        .single()
        .expect("valid start datetime");
    let in_week_end = Utc
        .with_ymd_and_hms(2026, 3, 25, 11, 0, 0)
        .single()
        .expect("valid end datetime");
    let out_of_week_start = Utc
        .with_ymd_and_hms(2026, 4, 2, 9, 0, 0)
        .single()
        .expect("valid next-week start datetime");
    let out_of_week_end = Utc
        .with_ymd_and_hms(2026, 4, 2, 10, 0, 0)
        .single()
        .expect("valid next-week end datetime");

    poneglyph
        .state_facts(vec![
            fact!(
                uri!("gcal:namespace"),
                uri!("schema:type"),
                Value::reference(uri!("schema:namespace"))
            ),
            fact!(
                uri!("gcal:namespace"),
                uri!("schema:name"),
                Value::text("Google Calendar")
            ),
            fact!(
                uri!("gcal:event"),
                uri!("schema:type"),
                Value::reference(uri!("schema:kind"))
            ),
            fact!(uri!("gcal:event"), uri!("schema:name"), Value::text("Event")),
            fact!(
                uri!("gcal:startAt"),
                uri!("schema:type"),
                Value::reference(uri!("schema:field"))
            ),
            fact!(
                uri!("gcal:startAt"),
                uri!("schema:name"),
                Value::text("Start At")
            ),
            fact!(
                uri!("gcal:startAt"),
                uri!("schema:field:domain"),
                Value::reference(uri!("gcal:event"))
            ),
            fact!(
                uri!("gcal:endAt"),
                uri!("schema:type"),
                Value::reference(uri!("schema:field"))
            ),
            fact!(uri!("gcal:endAt"), uri!("schema:name"), Value::text("End At")),
            fact!(
                uri!("gcal:endAt"),
                uri!("schema:field:domain"),
                Value::reference(uri!("gcal:event"))
            ),
            fact!(
                uri!("gcal:status"),
                uri!("schema:type"),
                Value::reference(uri!("schema:field"))
            ),
            fact!(
                uri!("gcal:status"),
                uri!("schema:name"),
                Value::text("Status")
            ),
            fact!(
                uri!("gcal:status"),
                uri!("schema:field:domain"),
                Value::reference(uri!("gcal:event"))
            ),
            fact!(
                uri!("gcal:calendar"),
                uri!("schema:type"),
                Value::reference(uri!("schema:field"))
            ),
            fact!(
                uri!("gcal:calendar"),
                uri!("schema:name"),
                Value::text("Calendar")
            ),
            fact!(
                uri!("gcal:calendar"),
                uri!("schema:field:domain"),
                Value::reference(uri!("gcal:event"))
            ),
            fact!(
                calendar.clone(),
                uri!("schema:type"),
                Value::reference(uri!("gcal:calendar"))
            ),
            fact!(
                calendar.clone(),
                uri!("schema:name"),
                Value::text("Personal Calendar")
            ),
            fact!(
                in_week_event.clone(),
                uri!("schema:type"),
                Value::reference(uri!("gcal:event"))
            ),
            fact!(
                in_week_event.clone(),
                uri!("schema:name"),
                Value::text(IN_WEEK_EVENT_NAME)
            ),
            fact!(
                in_week_event.clone(),
                uri!("gcal:calendar"),
                Value::reference(calendar.clone())
            ),
            fact!(
                in_week_event.clone(),
                uri!("gcal:status"),
                Value::text("confirmed")
            ),
            fact!(
                in_week_event.clone(),
                uri!("gcal:startAt"),
                Value::date_time(in_week_start)
            ),
            fact!(
                in_week_event.clone(),
                uri!("gcal:endAt"),
                Value::date_time(in_week_end)
            ),
            fact!(
                out_of_week_event.clone(),
                uri!("schema:type"),
                Value::reference(uri!("gcal:event"))
            ),
            fact!(
                out_of_week_event.clone(),
                uri!("schema:name"),
                Value::text(OUT_OF_WEEK_EVENT_NAME)
            ),
            fact!(
                out_of_week_event.clone(),
                uri!("gcal:calendar"),
                Value::reference(calendar)
            ),
            fact!(
                out_of_week_event.clone(),
                uri!("gcal:status"),
                Value::text("confirmed")
            ),
            fact!(
                out_of_week_event.clone(),
                uri!("gcal:startAt"),
                Value::date_time(out_of_week_start)
            ),
            fact!(
                out_of_week_event,
                uri!("gcal:endAt"),
                Value::date_time(out_of_week_end)
            ),
        ])
        .await?;

    Ok(())
}
