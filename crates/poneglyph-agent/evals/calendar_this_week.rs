use std::sync::Arc;

use anyhow::Result;
use chrono::{TimeZone, Utc};
use evals::{
    EvalContext, GradeResult, GradingConfig, Trajectory, eval, predicate, suite, trajectory,
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
    Ok(trajectory![
        user!(WEEKLY_CALENDAR_PROMPT),
        assistant!(GradingConfig::new()
            .grader(predicate("uses-schema-then-query", |trial, _ctx| async move {
                let schema_index = trial
                    .tool_trace
                    .iter()
                    .position(|call| call.id == "get_schema" || call.name == "get_schema");
                let query_index = trial
                    .tool_trace
                    .iter()
                    .position(|call| call.id == "query_facts" || call.name == "query_facts");

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
                        "toolTrace": trial.tool_trace,
                        "reply": trial.final_reply,
                    }),
                })
            }))
            .grader(predicate("identifies-in-week-event", |trial, _ctx| async move {
                let reply: String = trial.final_reply.unwrap_or_default();
                let reply_lower = reply.to_lowercase();
                let mentions_in_week = reply_lower.contains(&IN_WEEK_EVENT_NAME.to_lowercase());
                let excludes_out_of_week =
                    !reply_lower.contains(&OUT_OF_WEEK_EVENT_NAME.to_lowercase());

                let (score, summary) = if mentions_in_week && excludes_out_of_week {
                    (
                        1.0,
                        "agent identified the in-week event without leaking the out-of-week event"
                            .to_string(),
                    )
                } else if !mentions_in_week {
                    (
                        0.0,
                        "agent did not mention the event that actually occurs this week"
                            .to_string(),
                    )
                } else {
                    (
                        0.0,
                        "agent included an event that falls outside the requested week".to_string(),
                    )
                };

                Ok(GradeResult {
                    score,
                    summary,
                    evidence: serde_json::json!({
                        "reply": reply,
                    }),
                })
            }))),
    ])
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
