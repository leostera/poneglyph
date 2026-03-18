use agents::{
    agent::SessionAgent,
    evals::{eval, suite, trajectory, EvalContext, Trajectory},
};
use anyhow::Result;

type BasicAgent = SessionAgent<String, (), (), String>;

#[suite(
    kind = "regression",
    agent = new_agent,
)]

async fn new_agent(ctx: EvalContext<()>) -> Result<BasicAgent> {
    Ok(SessionAgent::builder()
        .with_llm_runner(ctx.llm_runner())
        .build()?)
}

#[eval(
    agent = BasicAgent,
    desc = "dummy eval",
    tags = ["dummy", "test"],
)]
async fn dummy_eval(_ctx: EvalContext<()>) -> Result<Trajectory<BasicAgent, ()>> {
    Ok(trajectory![user!("hello world")])
}
