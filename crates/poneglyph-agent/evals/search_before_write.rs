use std::sync::Arc;

use anyhow::Result;
use evals::{EvalContext, GradeResult, Trajectory, eval, predicate, suite, trajectory};
use poneglyph::{Poneglyph, Workspace};
use tempfile::tempdir;

use crate::PoneglyphAgent;

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

    PoneglyphAgent::new_with_runner(poneglyph, ctx.llm_runner())
}

#[eval(
    agent = PoneglyphAgent,
    desc = "searches before attempting graph writes",
    tags = ["poneglyph-agent", "writes", "search-before-write"],
)]
async fn search_before_write(_ctx: EvalContext<()>) -> Result<Trajectory<PoneglyphAgent, ()>> {
    Ok(trajectory![
        user!(
            "Record the movie Dune in the graph. Reuse an existing entity if it already exists; otherwise create one."
        ),
        assistant!(predicate("searches-before-write", |trial, _ctx| async move {
            let search_index = trial
                .tool_trace
                .iter()
                .position(|call| call.id == "search_entities" || call.name == "search_entities");
            let write_index = trial.tool_trace.iter().position(|call| {
                matches!(call.id.as_str(), "create_entity" | "state_facts")
                    || matches!(call.name.as_str(), "create_entity" | "state_facts")
            });

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
                    "agent searched but did not attempt the requested write".to_string(),
                ),
                (None, Some(_)) => (
                    0.0,
                    "agent attempted a write without searching the graph first".to_string(),
                ),
                (None, None) => (
                    0.0,
                    "agent neither searched nor wrote when asked to record new knowledge"
                        .to_string(),
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
        })),
    ])
}
