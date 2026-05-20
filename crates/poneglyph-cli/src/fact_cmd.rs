use anyhow::Result;
use poneglyph_api::{
    active_fact_from_proto, fact_from_proto, fact_to_proto,
    proto::{
        ListFactsRequest, ListFactsResponse, RetractFactByIdRequest, StateFactTypedRequest,
        poneglyph_daemon_client::PoneglyphDaemonClient,
    },
};
use poneglyph_core::{ActiveFact, ActiveFilter, Fact, Filter, Value, Workspace};

use crate::cli::{FactCommand, FactSubcommand};
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;
use crate::util::{collect_results, parse_uri, usize_to_u64};

type DaemonClient = PoneglyphDaemonClient<tonic::transport::Channel>;

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: FactCommand,
) -> Result<()> {
    match command.command {
        FactSubcommand::List {
            entity,
            tx,
            active,
            limit,
            offset,
            json,
        } => {
            let facts = list_facts(
                &workspace,
                &config,
                entity.as_deref(),
                tx.as_deref(),
                active,
                limit,
                offset,
            )
            .await?;
            print_fact_list(&facts, json)
        }
        FactSubcommand::State {
            entity,
            attribute,
            value,
            source,
            json,
        } => {
            let fact = build_assertion_fact(&entity, &attribute, &value, source.as_deref())?;
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
            let fact = build_retraction_fact(&entity, &attribute, &value)?;
            let outcome = state_fact(&workspace, &config, fact).await?;
            print_fact_outcome(&outcome, json)
        }
        FactSubcommand::Retract { .. } => {
            anyhow::bail!("retract requires --fact or entity attribute value")
        }
    }
}

fn build_assertion_fact(
    entity: &str,
    attribute: &str,
    value: &str,
    source: Option<&str>,
) -> Result<Fact> {
    Ok(Fact::builder()
        .source(parse_uri(source.unwrap_or("poneglyph:cli"))?)
        .entity(parse_uri(entity)?)
        .field(parse_uri(attribute)?)
        .value(parse_cli_value(value)?)
        .build()?)
}

fn build_retraction_fact(entity: &str, attribute: &str, value: &str) -> Result<Fact> {
    Ok(Fact::builder()
        .source(parse_uri("poneglyph:cli")?)
        .entity(parse_uri(entity)?)
        .field(parse_uri(attribute)?)
        .value(parse_cli_value(value)?)
        .retract()
        .build()?)
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

enum FactList {
    Log(Vec<Fact>),
    Active(Vec<ActiveFact>),
}

impl FactList {
    fn paginate(self, limit: usize, offset: usize) -> Self {
        match self {
            FactList::Log(facts) => {
                FactList::Log(facts.into_iter().skip(offset).take(limit).collect())
            }
            FactList::Active(facts) => {
                FactList::Active(facts.into_iter().skip(offset).take(limit).collect())
            }
        }
    }
}

fn print_fact_list(facts: &FactList, json: bool) -> Result<()> {
    if json {
        match facts {
            FactList::Log(facts) => println!("{}", serde_json::to_string_pretty(facts)?),
            FactList::Active(facts) => println!("{}", serde_json::to_string_pretty(facts)?),
        }
        return Ok(());
    }

    for line in plain_fact_list_lines(facts)? {
        println!("{line}");
    }
    Ok(())
}

fn plain_fact_list_lines(facts: &FactList) -> Result<Vec<String>> {
    match facts {
        FactList::Log(facts) if facts.is_empty() => Ok(vec!["no facts".to_string()]),
        FactList::Log(facts) => facts.iter().map(plain_log_fact_line).collect(),
        FactList::Active(facts) if facts.is_empty() => Ok(vec!["no facts".to_string()]),
        FactList::Active(facts) => facts.iter().map(plain_active_fact_line).collect(),
    }
}

fn plain_log_fact_line(fact: &Fact) -> Result<String> {
    let tx_id = fact
        .tx_id
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_else(|| "pending".to_string());
    let kind = if fact.retraction {
        "retraction"
    } else {
        "assertion"
    };
    Ok(format!(
        "fact\t{}\t{}\t{}\t{}\t{}\t{}",
        fact.fact_id,
        tx_id,
        fact.entity,
        fact.field,
        value_json(&fact.value)?,
        kind
    ))
}

fn plain_active_fact_line(fact: &ActiveFact) -> Result<String> {
    Ok(format!(
        "active\t{}\t{}\t{}\t{}\t{}",
        fact.fact_id,
        fact.tx_id,
        fact.entity,
        fact.field,
        value_json(&fact.value)?
    ))
}

fn value_json(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(Into::into)
}

async fn list_facts(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    entity: Option<&str>,
    tx: Option<&str>,
    active: bool,
    limit: usize,
    offset: usize,
) -> Result<FactList> {
    match daemon_client(config).await {
        Ok(client) => list_facts_via_daemon(client, entity, tx, active, limit, offset).await,
        Err(_) => list_facts_direct(workspace, config, entity, tx, active, limit, offset).await,
    }
}

async fn list_facts_via_daemon(
    mut client: DaemonClient,
    entity: Option<&str>,
    tx: Option<&str>,
    active: bool,
    limit: usize,
    offset: usize,
) -> Result<FactList> {
    let response = client
        .list_facts_typed(ListFactsRequest {
            entity_uri: entity.unwrap_or_default().to_string(),
            tx_id: tx.unwrap_or_default().to_string(),
            active,
            limit: usize_to_u64(limit)?,
            offset: usize_to_u64(offset)?,
        })
        .await?
        .into_inner();
    fact_list_from_typed_response(response)
}

fn fact_list_from_typed_response(response: ListFactsResponse) -> Result<FactList> {
    if response.active {
        let facts = response
            .active_facts
            .into_iter()
            .map(active_fact_from_proto)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(anyhow::Error::msg)?;
        Ok(FactList::Active(facts))
    } else {
        let facts = response
            .facts
            .into_iter()
            .map(fact_from_proto)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(anyhow::Error::msg)?;
        Ok(FactList::Log(facts))
    }
}

async fn list_facts_direct(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    entity: Option<&str>,
    tx: Option<&str>,
    active: bool,
    limit: usize,
    offset: usize,
) -> Result<FactList> {
    let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
    if active {
        if tx.is_some() {
            anyhow::bail!("active fact listing does not support --tx");
        }
        let filter = match entity {
            Some(entity) => ActiveFilter::ByEntity(parse_uri(entity)?),
            None => ActiveFilter::All,
        };
        let facts = poneglyph
            .fact_service()
            .store()
            .get_active_facts(filter)
            .await?;
        return Ok(FactList::Active(collect_results(facts).await?).paginate(limit, offset));
    }

    let filter = match (entity, tx) {
        (Some(entity), None) => Filter::ByEntityUri(parse_uri(entity)?),
        (None, Some(tx)) => Filter::ByTx(parse_uri(tx)?),
        (None, None) => Filter::All,
        (Some(_), Some(_)) => anyhow::bail!("fact list accepts only one filter: --entity or --tx"),
    };
    let facts = poneglyph.fact_service().get_facts(filter).await?;
    Ok(FactList::Log(collect_results(facts).await?).paginate(limit, offset))
}

async fn state_fact(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    fact: Fact,
) -> Result<FactOutcome> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let response = client
                .state_fact_typed(StateFactTypedRequest {
                    fact: Some(fact_to_proto(&fact)),
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

#[cfg(test)]
mod tests {
    use poneglyph_api::{active_fact_to_proto, fact_to_proto, proto::ListFactsResponse};
    use poneglyph_core::{ActiveFact, Fact, Value};

    use super::{FactList, fact_list_from_typed_response, plain_fact_list_lines};
    use crate::util::parse_uri;

    fn assertion_fact() -> Fact {
        let mut fact = Fact::builder()
            .source(parse_uri("poneglyph:cli").expect("source"))
            .entity(parse_uri("spotify:album:signals").expect("entity"))
            .field(parse_uri("spotify:displayName").expect("field"))
            .value(Value::text("Signals"))
            .build()
            .expect("fact");
        fact.fact_id = parse_uri("poneglyph:fact:1").expect("fact id");
        fact.tx_id = Some(parse_uri("poneglyph:tx:1").expect("tx id"));
        fact
    }

    #[test]
    fn plain_fact_list_lines_formats_log_facts_and_empty_logs() {
        let lines = plain_fact_list_lines(&FactList::Log(vec![assertion_fact()])).expect("lines");

        assert_eq!(
            lines,
            vec![
                "fact\tponeglyph:fact:1\tponeglyph:tx:1\tspotify:album:signals\tspotify:displayName\t{\"type\":\"text\",\"value\":\"Signals\"}\tassertion"
            ]
        );
        assert_eq!(
            plain_fact_list_lines(&FactList::Log(vec![])).expect("empty"),
            vec!["no facts"]
        );
    }

    #[test]
    fn plain_fact_list_lines_formats_pending_retractions() {
        let mut fact = assertion_fact();
        fact.tx_id = None;
        fact.retraction = true;

        let lines = plain_fact_list_lines(&FactList::Log(vec![fact])).expect("lines");

        assert_eq!(
            lines,
            vec![
                "fact\tponeglyph:fact:1\tpending\tspotify:album:signals\tspotify:displayName\t{\"type\":\"text\",\"value\":\"Signals\"}\tretraction"
            ]
        );
    }

    fn active_fact() -> ActiveFact {
        ActiveFact {
            source: parse_uri("poneglyph:cli").expect("source"),
            entity: parse_uri("spotify:album:signals").expect("entity"),
            field: parse_uri("spotify:displayName").expect("field"),
            value: Value::text("Signals"),
            fact_id: parse_uri("poneglyph:fact:1").expect("fact id"),
            tx_id: parse_uri("poneglyph:tx:1").expect("tx id"),
        }
    }

    #[test]
    fn plain_fact_list_lines_formats_active_facts_and_empty_lists() {
        let lines = plain_fact_list_lines(&FactList::Active(vec![active_fact()])).expect("lines");

        assert_eq!(
            lines,
            vec![
                "active\tponeglyph:fact:1\tponeglyph:tx:1\tspotify:album:signals\tspotify:displayName\t{\"type\":\"text\",\"value\":\"Signals\"}"
            ]
        );
        assert_eq!(
            plain_fact_list_lines(&FactList::Active(vec![])).expect("empty"),
            vec!["no facts"]
        );
    }

    #[test]
    fn fact_list_from_typed_response_converts_log_and_active_payloads() {
        let log = fact_list_from_typed_response(ListFactsResponse {
            active: false,
            facts: vec![fact_to_proto(&assertion_fact())],
            active_facts: vec![],
        })
        .expect("log facts");
        let active = fact_list_from_typed_response(ListFactsResponse {
            active: true,
            facts: vec![],
            active_facts: vec![active_fact_to_proto(&active_fact())],
        })
        .expect("active facts");

        match log {
            FactList::Log(facts) => assert_eq!(facts.len(), 1),
            FactList::Active(_) => panic!("expected log facts"),
        }
        match active {
            FactList::Active(facts) => assert_eq!(facts.len(), 1),
            FactList::Log(_) => panic!("expected active facts"),
        }
    }
}
