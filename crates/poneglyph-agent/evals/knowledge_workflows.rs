use std::sync::Arc;

use anyhow::Result;
use chrono::{TimeZone, Utc};
use evals::{
    AgentTrial, EvalContext, EvalResult, GradeResult, GradingConfig, RecordedEvent, Trajectory,
    eval, judge, predicate, suite, trajectory,
};
use poneglyph::{Fact, Poneglyph, Uri, Value, Workspace, fact, uri};
use serde_json::{Value as JsonValue, json};
use tempfile::tempdir;

use crate::PoneglyphAgent;

const DESIGN_REVIEW: &str = "Design Review";
const DEMO_DAY: &str = "Demo Day";
const APRIL_KICKOFF: &str = "April Kickoff";
const INVOICE_REVIEW: &str = "Invoice Review";

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

    seed_fake_graph(&poneglyph).await?;

    PoneglyphAgent::new_with_runner(poneglyph, ctx.llm_runner())
}

#[eval(
    agent = PoneglyphAgent,
    desc = "answers today's events from graph facts",
    tags = ["poneglyph-agent", "calendar", "gcal", "querying", "time-windows"],
)]
async fn answers_events_today(_ctx: EvalContext<()>) -> Result<Trajectory<PoneglyphAgent, ()>> {
    Ok(trajectory![
        user!(
            "Today is Wednesday, March 25, 2026. Answer only from the Poneglyph graph. What events do I have today?"
        ),
        assistant!(GradingConfig::new()
            .grader(predicate("uses-schema-then-query", schema_then_query_grade))
            .grader(judge(
                "identifies-todays-events",
                format!(
                    "Read the transcript and final reply. Grade whether the assistant correctly answered the user's question about events happening today.\n\
                     Score 1.0 when the answer says that `{}` happens today on March 25, 2026.\n\
                     Score 1.0 even if it includes extra grounded details like timestamps, status, or the calendar.\n\
                     Score 0.0 if it says there are no events today, omits `{}`, or treats `{}` as happening today.",
                    DESIGN_REVIEW, DESIGN_REVIEW, APRIL_KICKOFF
                )
            ))),
    ])
}

#[eval(
    agent = PoneglyphAgent,
    desc = "answers monthly calendar questions from graph facts",
    tags = ["poneglyph-agent", "calendar", "gcal", "querying", "time-windows"],
)]
async fn answers_events_this_month(_ctx: EvalContext<()>) -> Result<Trajectory<PoneglyphAgent, ()>>
{
    Ok(trajectory![
        user!(
            "Today is Thursday, March 26, 2026. This month means March 1, 2026 through March 31, 2026, inclusive. Answer only from the Poneglyph graph. What events do I have this month?"
        ),
        assistant!(GradingConfig::new()
            .grader(predicate("uses-schema-then-query", schema_then_query_grade))
            .grader(judge(
                "identifies-month-events",
                format!(
                    "Read the transcript and final reply. Grade whether the assistant correctly answered the question about events in March 2026.\n\
                     Score 1.0 when the answer identifies both `{}` and `{}` as March events.\n\
                     Score 1.0 even if the answer includes extra grounded details like dates, times, or statuses.\n\
                     Score 0.0 if the answer misses either March event or incorrectly includes `{}` in March.",
                    DESIGN_REVIEW, DEMO_DAY, APRIL_KICKOFF
                )
            ))),
    ])
}

#[eval(
    agent = PoneglyphAgent,
    desc = "answers Gmail questions from graph facts",
    tags = ["poneglyph-agent", "gmail", "querying", "email"],
)]
async fn answers_email_question_from_gmail(
    _ctx: EvalContext<()>,
) -> Result<Trajectory<PoneglyphAgent, ()>> {
    Ok(trajectory![
        user!(
            "Today is Thursday, March 26, 2026. This week means March 23, 2026 through March 29, 2026, inclusive. Answer only from the Poneglyph graph. Did Alex email me about invoices this week?"
        ),
        assistant!(GradingConfig::new()
            .grader(predicate("uses-schema-then-query", schema_then_query_grade))
            .grader(judge(
                "identifies-invoice-email",
                format!(
                    "Read the transcript and final reply. Grade whether the assistant correctly answered the Gmail question from graph data.\n\
                     Score 1.0 when the answer says yes and identifies an invoice-related message from Alex during the requested week, ideally using `{}`.\n\
                     Score 1.0 even if the answer includes extra grounded details like the sender address, snippet, or received timestamp.\n\
                     Score 0.0 if the answer says no, misses the invoice email, or invents a different sender.",
                    INVOICE_REVIEW
                )
            ))),
    ])
}

#[eval(
    agent = PoneglyphAgent,
    desc = "refuses unsupported answers when the graph lacks evidence",
    tags = ["poneglyph-agent", "grounding", "calendar", "gcal"],
)]
async fn refuses_to_answer_when_graph_lacks_evidence(
    _ctx: EvalContext<()>,
) -> Result<Trajectory<PoneglyphAgent, ()>> {
    Ok(trajectory![
        user!(
            "Today is Thursday, March 26, 2026. Next week means March 30, 2026 through April 5, 2026, inclusive. Answer only from the Poneglyph graph. What dentist appointment do I have next week?"
        ),
        assistant!(GradingConfig::new()
            .grader(predicate("uses-schema-then-query", schema_then_query_grade))
            .grader(judge(
                "refuses-without-graph-evidence",
                "Read the transcript and final reply. Grade whether the assistant stays grounded when the graph does not show a dentist appointment.\n\
                 Score 1.0 when the answer clearly says it cannot find a dentist appointment in the Poneglyph graph for the requested week, or otherwise says there is no graph evidence for one.\n\
                 Score 1.0 even if it briefly mentions the date range it checked.\n\
                 Score 0.0 if it invents an appointment, claims one exists without graph support, or answers from world knowledge."
            ))),
    ])
}

#[eval(
    agent = PoneglyphAgent,
    desc = "asks for clarification before querying ambiguous time windows",
    tags = ["poneglyph-agent", "grounding", "clarification"],
)]
async fn asks_for_clarification_when_time_range_is_ambiguous(
    _ctx: EvalContext<()>,
) -> Result<Trajectory<PoneglyphAgent, ()>> {
    Ok(trajectory![
        user!("What events do I have coming up?"),
        assistant!(GradingConfig::new()
            .grader(predicate("clarifies-before-query", clarification_before_query_grade))
            .grader(judge(
                "asks-for-time-range-clarification",
                "Read the transcript and final reply. Grade whether the assistant asked the user to clarify the time window for an ambiguous request like 'coming up'.\n\
                 Score 1.0 when the reply asks a concise follow-up question about the time range or date window before trying to answer.\n\
                 Score 0.0 if the assistant answers directly, queries the graph first, or assumes an arbitrary time window."
            ))),
    ])
}

#[eval(
    agent = PoneglyphAgent,
    desc = "queries across Gmail and Google Calendar",
    tags = ["poneglyph-agent", "gcal", "gmail", "querying", "cross-connector"],
)]
async fn queries_across_multiple_connectors(
    _ctx: EvalContext<()>,
) -> Result<Trajectory<PoneglyphAgent, ()>> {
    Ok(trajectory![
        user!(
            "Today is Thursday, March 26, 2026. This week means March 23, 2026 through March 29, 2026, inclusive. Answer only from the Poneglyph graph. Which event this week has an email thread attached to it?"
        ),
        assistant!(GradingConfig::new()
            .grader(predicate("uses-schema-then-query", schema_then_query_grade))
            .grader(judge(
                "identifies-cross-connector-event",
                format!(
                    "Read the transcript and final reply. Grade whether the assistant correctly answered the cross-connector question from graph data.\n\
                     Score 1.0 when the answer identifies `{}` as the in-week event that has an attached email thread.\n\
                     Score 1.0 even if it includes extra grounded details like the matching email subject or sender.\n\
                     Score 0.0 if it misses `{}`, names the wrong event, or invents a connection not present in the graph.",
                    DESIGN_REVIEW, DESIGN_REVIEW
                )
            ))),
    ])
}

#[eval(
    agent = PoneglyphAgent,
    desc = "reuses existing entities when extracting a fact from text",
    tags = ["poneglyph-agent", "writes", "search-before-write", "dedupe", "extraction"],
)]
async fn links_new_facts_to_existing_entities(
    _ctx: EvalContext<()>,
) -> Result<Trajectory<PoneglyphAgent, ()>> {
    Ok(trajectory![
        user!(
            "From this note, record that Denis Villeneuve directed Dune. Reuse existing entities if they already exist and answer briefly when done.\n\nNote: Denis Villeneuve directed Dune."
        ),
        assistant!(GradingConfig::new()
            .grader(predicate("searches-before-write", search_before_write_grade))
            .grader(predicate("reuses-existing-entities", reuse_existing_entities_grade))),
    ])
}

async fn schema_then_query_grade(
    trial: AgentTrial<String>,
    _ctx: EvalContext<()>,
) -> EvalResult<GradeResult> {
    let requested_tools = requested_tool_names(&trial.transcript);
    let schema_index = requested_tools
        .iter()
        .position(|name| name.as_str() == "get_schema");
    let query_index = requested_tools.iter().position(|name| {
        matches!(
            name.as_str(),
            "query_facts" | "query_entities" | "search_entities" | "read_entity"
        )
    });

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
        evidence: json!({
            "requestedTools": requested_tools,
            "toolTrace": trial.tool_trace,
            "reply": trial.final_reply,
        }),
    })
}

async fn clarification_before_query_grade(
    trial: AgentTrial<String>,
    _ctx: EvalContext<()>,
) -> EvalResult<GradeResult> {
    let requested_tools = requested_tool_names(&trial.transcript);
    let queried = requested_tools.iter().any(|name| {
        matches!(
            name.as_str(),
            "get_schema" | "query_facts" | "query_entities" | "search_entities" | "read_entity"
        )
    });

    let (score, summary) = if queried {
        (
            0.0,
            "agent queried the graph instead of clarifying the ambiguous time window".to_string(),
        )
    } else {
        (
            1.0,
            "agent did not query before asking for clarification".to_string(),
        )
    };

    Ok(GradeResult {
        score,
        summary,
        evidence: json!({
            "requestedTools": requested_tools,
            "reply": trial.final_reply,
        }),
    })
}

async fn search_before_write_grade(
    trial: AgentTrial<String>,
    _ctx: EvalContext<()>,
) -> EvalResult<GradeResult> {
    let requested_tools = requested_tool_names(&trial.transcript);
    let search_index = requested_tools
        .iter()
        .position(|name| name.as_str() == "search_entities");
    let write_index = requested_tools
        .iter()
        .position(|name| matches!(name.as_str(), "create_entity" | "state_facts"));

    let (score, summary) = match (search_index, write_index) {
        (Some(search_index), Some(write_index)) if search_index < write_index => (
            1.0,
            "agent searched the graph before attempting a write".to_string(),
        ),
        (Some(_), Some(_)) => (
            0.0,
            "agent attempted a write before searching the graph".to_string(),
        ),
        (Some(_), None) => (
            0.0,
            "agent searched but never wrote the requested fact".to_string(),
        ),
        (None, Some(_)) => (
            0.0,
            "agent attempted a write without searching first".to_string(),
        ),
        (None, None) => (0.0, "agent neither searched nor wrote".to_string()),
    };

    Ok(GradeResult {
        score,
        summary,
        evidence: json!({
            "requestedTools": requested_tools,
            "reply": trial.final_reply,
        }),
    })
}

async fn reuse_existing_entities_grade(
    trial: AgentTrial<String>,
    _ctx: EvalContext<()>,
) -> EvalResult<GradeResult> {
    let requested_tools = requested_tool_names(&trial.transcript);
    let create_attempted = requested_tools
        .iter()
        .any(|name| name.as_str() == "create_entity");
    let state_facts_call = last_tool_arguments(&trial.transcript, "state_facts");

    let linking_fact_present = state_facts_call
        .as_ref()
        .and_then(find_directed_by_fact)
        .is_some();
    let uses_existing_entities = state_facts_call
        .as_ref()
        .is_some_and(|arguments| entities_include_expected_existing_nodes(arguments));

    let (score, summary) = if create_attempted {
        (
            0.0,
            "agent created a new entity instead of reusing the existing ones".to_string(),
        )
    } else if !uses_existing_entities {
        (
            0.0,
            "state_facts did not declare the existing Dune and Denis entities".to_string(),
        )
    } else if !linking_fact_present {
        (
            0.0,
            "state_facts did not assert the movie:directedBy relationship using existing entity URIs"
                .to_string(),
        )
    } else {
        (
            1.0,
            "agent reused the existing movie and person entities and linked them with a fact"
                .to_string(),
        )
    };

    Ok(GradeResult {
        score,
        summary,
        evidence: json!({
            "requestedTools": requested_tools,
            "stateFactsArguments": state_facts_call,
            "reply": trial.final_reply,
        }),
    })
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

fn last_tool_arguments(events: &[RecordedEvent], tool_name: &str) -> Option<JsonValue> {
    events.iter().rev().find_map(|event| match event {
        RecordedEvent::ToolCallRequested {
            name, arguments, ..
        } if name == tool_name => Some(arguments.clone()),
        _ => None,
    })
}

fn entities_include_expected_existing_nodes(arguments: &JsonValue) -> bool {
    let Some(entities) = arguments.get("entities").and_then(JsonValue::as_array) else {
        return false;
    };

    let values = entities
        .iter()
        .filter_map(JsonValue::as_str)
        .collect::<Vec<_>>();

    values.contains(&"movie:movie:dune") && values.contains(&"movie:person:denis-villeneuve")
}

fn find_directed_by_fact(arguments: &JsonValue) -> Option<&JsonValue> {
    arguments
        .get("facts")
        .and_then(JsonValue::as_array)
        .and_then(|facts| {
            facts.iter().find(|fact| {
                fact.get("entity").and_then(JsonValue::as_str) == Some("movie:movie:dune")
                    && fact.get("field").and_then(JsonValue::as_str)
                        == Some("movie:directedBy")
                    && fact
                        .get("value")
                        .and_then(JsonValue::as_object)
                        .and_then(|value| value.get("type"))
                        .and_then(JsonValue::as_str)
                        == Some("reference")
                    && fact
                        .get("value")
                        .and_then(JsonValue::as_object)
                        .and_then(|value| value.get("reference"))
                        .and_then(JsonValue::as_str)
                        == Some("movie:person:denis-villeneuve")
            })
        })
}

async fn seed_fake_graph(poneglyph: &Arc<Poneglyph>) -> Result<()> {
    let mut facts = Vec::new();

    facts.extend(namespace_facts("gcal:namespace", "Google Calendar")?);
    facts.extend(kind_facts("gcal:calendar", "Calendar")?);
    facts.extend(kind_facts("gcal:event", "Event")?);
    facts.extend(field_facts("gcal:calendar", "Calendar", "gcal:event")?);
    facts.extend(field_facts("gcal:startAt", "Start At", "gcal:event")?);
    facts.extend(field_facts("gcal:endAt", "End At", "gcal:event")?);
    facts.extend(field_facts("gcal:status", "Status", "gcal:event")?);

    facts.extend(namespace_facts("gmail:namespace", "Gmail")?);
    facts.extend(kind_facts("gmail:message", "Message")?);
    facts.extend(field_facts("gmail:fromEmail", "From Email", "gmail:message")?);
    facts.extend(field_facts("gmail:receivedAt", "Received At", "gmail:message")?);
    facts.extend(field_facts("gmail:snippet", "Snippet", "gmail:message")?);
    facts.extend(field_facts("gmail:aboutEvent", "About Event", "gmail:message")?);

    facts.extend(namespace_facts("movie:namespace", "Movies")?);
    facts.extend(kind_facts("movie:movie", "Movie")?);
    facts.extend(kind_facts("movie:person", "Person")?);
    facts.extend(field_facts("movie:directedBy", "Directed By", "movie:movie")?);

    facts.extend(named_entity_facts(
        "gcal:calendar:personal",
        "gcal:calendar",
        "Personal Calendar",
    )?);
    facts.extend(named_entity_facts(
        "gcal:event:design-review",
        "gcal:event",
        DESIGN_REVIEW,
    )?);
    facts.push(fact!(
        parsed_uri("gcal:event:design-review")?,
        parsed_uri("gcal:calendar")?,
        Value::reference(parsed_uri("gcal:calendar:personal")?)
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:design-review")?,
        parsed_uri("gcal:status")?,
        Value::text("confirmed")
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:design-review")?,
        parsed_uri("gcal:startAt")?,
        Value::date_time(ts(2026, 3, 25, 10, 0, 0))
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:design-review")?,
        parsed_uri("gcal:endAt")?,
        Value::date_time(ts(2026, 3, 25, 11, 0, 0))
    ));

    facts.extend(named_entity_facts(
        "gcal:event:demo-day",
        "gcal:event",
        DEMO_DAY,
    )?);
    facts.push(fact!(
        parsed_uri("gcal:event:demo-day")?,
        parsed_uri("gcal:calendar")?,
        Value::reference(parsed_uri("gcal:calendar:personal")?)
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:demo-day")?,
        parsed_uri("gcal:status")?,
        Value::text("confirmed")
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:demo-day")?,
        parsed_uri("gcal:startAt")?,
        Value::date_time(ts(2026, 3, 28, 15, 0, 0))
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:demo-day")?,
        parsed_uri("gcal:endAt")?,
        Value::date_time(ts(2026, 3, 28, 17, 0, 0))
    ));

    facts.extend(named_entity_facts(
        "gcal:event:april-kickoff",
        "gcal:event",
        APRIL_KICKOFF,
    )?);
    facts.push(fact!(
        parsed_uri("gcal:event:april-kickoff")?,
        parsed_uri("gcal:calendar")?,
        Value::reference(parsed_uri("gcal:calendar:personal")?)
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:april-kickoff")?,
        parsed_uri("gcal:status")?,
        Value::text("confirmed")
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:april-kickoff")?,
        parsed_uri("gcal:startAt")?,
        Value::date_time(ts(2026, 4, 2, 9, 0, 0))
    ));
    facts.push(fact!(
        parsed_uri("gcal:event:april-kickoff")?,
        parsed_uri("gcal:endAt")?,
        Value::date_time(ts(2026, 4, 2, 10, 0, 0))
    ));

    facts.extend(named_entity_facts(
        "gmail:message:invoice-review",
        "gmail:message",
        INVOICE_REVIEW,
    )?);
    facts.push(fact!(
        parsed_uri("gmail:message:invoice-review")?,
        parsed_uri("gmail:fromEmail")?,
        Value::text("alex@example.com")
    ));
    facts.push(fact!(
        parsed_uri("gmail:message:invoice-review")?,
        parsed_uri("gmail:receivedAt")?,
        Value::date_time(ts(2026, 3, 24, 8, 30, 0))
    ));
    facts.push(fact!(
        parsed_uri("gmail:message:invoice-review")?,
        parsed_uri("gmail:snippet")?,
        Value::text("Please review the March invoice before Design Review.")
    ));
    facts.push(fact!(
        parsed_uri("gmail:message:invoice-review")?,
        parsed_uri("gmail:aboutEvent")?,
        Value::reference(parsed_uri("gcal:event:design-review")?)
    ));

    facts.extend(named_entity_facts(
        "gmail:message:team-lunch",
        "gmail:message",
        "Team Lunch",
    )?);
    facts.push(fact!(
        parsed_uri("gmail:message:team-lunch")?,
        parsed_uri("gmail:fromEmail")?,
        Value::text("bea@example.com")
    ));
    facts.push(fact!(
        parsed_uri("gmail:message:team-lunch")?,
        parsed_uri("gmail:receivedAt")?,
        Value::date_time(ts(2026, 3, 26, 12, 0, 0))
    ));
    facts.push(fact!(
        parsed_uri("gmail:message:team-lunch")?,
        parsed_uri("gmail:snippet")?,
        Value::text("Lunch on Friday?")
    ));

    facts.extend(named_entity_facts("movie:movie:dune", "movie:movie", "Dune")?);
    facts.extend(named_entity_facts(
        "movie:person:denis-villeneuve",
        "movie:person",
        "Denis Villeneuve",
    )?);

    poneglyph.state_facts(facts).await?;
    Ok(())
}

fn namespace_facts(entity_uri: &str, label: &str) -> Result<Vec<Fact>> {
    Ok(vec![
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:type"),
            Value::reference(uri!("schema:namespace"))
        ),
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:name"),
            Value::text(label)
        ),
    ])
}

fn kind_facts(entity_uri: &str, label: &str) -> Result<Vec<Fact>> {
    Ok(vec![
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:type"),
            Value::reference(uri!("schema:kind"))
        ),
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:name"),
            Value::text(label)
        ),
    ])
}

fn field_facts(entity_uri: &str, label: &str, domain_uri: &str) -> Result<Vec<Fact>> {
    Ok(vec![
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:type"),
            Value::reference(uri!("schema:field"))
        ),
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:name"),
            Value::text(label)
        ),
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:field:domain"),
            Value::reference(parsed_uri(domain_uri)?)
        ),
    ])
}

fn named_entity_facts(entity_uri: &str, type_uri: &str, label: &str) -> Result<Vec<Fact>> {
    Ok(vec![
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:type"),
            Value::reference(parsed_uri(type_uri)?)
        ),
        fact!(
            parsed_uri(entity_uri)?,
            uri!("schema:name"),
            Value::text(label)
        ),
    ])
}

fn parsed_uri(input: &str) -> Result<Uri> {
    Ok(Uri::parse(input)?)
}

fn ts(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
        .single()
        .expect("valid datetime")
}
