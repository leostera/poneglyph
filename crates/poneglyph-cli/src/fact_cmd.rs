use anyhow::Result;
use poneglyph_api::proto::{RetractFactByIdRequest, StateFactRequest};
use poneglyph_core::{Fact, Filter, Uri, Value, Workspace};

use crate::cli::{FactCommand, FactSubcommand};
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: FactCommand,
) -> Result<()> {
    match command.command {
        FactSubcommand::State {
            entity,
            attribute,
            value,
            source,
            json,
        } => {
            let fact = Fact::builder()
                .source(parse_uri(source.as_deref().unwrap_or("poneglyph:cli"))?)
                .entity(parse_uri(&entity)?)
                .field(parse_uri(&attribute)?)
                .value(parse_cli_value(&value)?)
                .build()?;
            let outcome = state_fact(&workspace, &config, fact).await?;
            print_fact_outcome(&outcome, json)
        }
        FactSubcommand::Retract {
            fact: Some(fact_id),
            json,
            ..
        } => {
            let outcome = retract_fact_by_id(&workspace, &config, &fact_id).await?;
            print_fact_outcome(&outcome, json)
        }
        FactSubcommand::Retract {
            fact: None,
            entity: Some(entity),
            attribute: Some(attribute),
            value: Some(value),
            json,
        } => {
            let fact = Fact::builder()
                .source(parse_uri("poneglyph:cli")?)
                .entity(parse_uri(&entity)?)
                .field(parse_uri(&attribute)?)
                .value(parse_cli_value(&value)?)
                .retract()
                .build()?;
            let outcome = state_fact(&workspace, &config, fact).await?;
            print_fact_outcome(&outcome, json)
        }
        FactSubcommand::Retract { .. } => {
            anyhow::bail!("retract requires --fact or entity attribute value")
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
struct FactOutcome {
    tx_id: String,
    fact_id: String,
    fact_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retracted_fact_id: Option<String>,
}

fn print_fact_outcome(outcome: &FactOutcome, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(outcome)?);
    } else {
        println!("tx_id: {}", outcome.tx_id);
        if !outcome.fact_id.is_empty() {
            println!("fact_id: {}", outcome.fact_id);
        }
        if let Some(retracted_fact_id) = &outcome.retracted_fact_id {
            println!("retracted_fact_id: {retracted_fact_id}");
        }
    }
    Ok(())
}

async fn state_fact(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    fact: Fact,
) -> Result<FactOutcome> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let response = client
                .state_fact(StateFactRequest {
                    fact_json: serde_json::to_string(&fact)?,
                })
                .await?
                .into_inner();
            Ok(FactOutcome {
                tx_id: response.tx_id,
                fact_id: response.fact_id,
                fact_ids: response.fact_ids,
                retracted_fact_id: None,
            })
        }
        Err(_) => {
            let fact_id = fact.fact_id.to_string();
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            let tx_id = poneglyph.state_facts(vec![fact]).await?.to_string();
            Ok(FactOutcome {
                tx_id,
                fact_id: fact_id.clone(),
                fact_ids: vec![fact_id],
                retracted_fact_id: None,
            })
        }
    }
}

async fn retract_fact_by_id(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    fact_id: &str,
) -> Result<FactOutcome> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let response = client
                .retract_fact_by_id(RetractFactByIdRequest {
                    fact_id: fact_id.to_string(),
                })
                .await?
                .into_inner();
            Ok(FactOutcome {
                tx_id: response.tx_id,
                fact_id: response.fact_id,
                fact_ids: response.fact_ids,
                retracted_fact_id: Some(fact_id.to_string()),
            })
        }
        Err(_) => {
            let fact_id = parse_uri(fact_id)?;
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            let mut facts = poneglyph
                .fact_service()
                .get_facts(Filter::ById(fact_id.clone()))
                .await?;
            let fact = facts
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("fact `{fact_id}` not found"))??;
            let retraction = Fact::builder()
                .source(fact.source)
                .entity(fact.entity)
                .field(fact.field)
                .value(fact.value)
                .retract()
                .build()?;
            let retraction_id = retraction.fact_id.to_string();
            let tx_id = poneglyph.state_facts(vec![retraction]).await?.to_string();
            Ok(FactOutcome {
                tx_id,
                fact_id: retraction_id.clone(),
                fact_ids: vec![retraction_id],
                retracted_fact_id: Some(fact_id.to_string()),
            })
        }
    }
}

fn parse_uri(value: &str) -> Result<Uri> {
    Uri::parse(value.to_string()).map_err(Into::into)
}

fn parse_cli_value(value: &str) -> Result<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(value) {
        return Ok(value);
    }
    if let Some(value) = value.strip_prefix("bool:") {
        return Ok(Value::boolean(value.parse()?));
    }
    if let Some(value) = value.strip_prefix("num:") {
        return Ok(Value::number(value));
    }
    if let Some(uri) = value.strip_prefix("ref:") {
        return Ok(Value::reference(parse_uri(uri)?));
    }
    Ok(Value::text(value))
}
