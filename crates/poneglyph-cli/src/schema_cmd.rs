use std::path::Path;

use anyhow::Result;
use poneglyph_api::proto::{GetSchemaRequest, StateFactsRequest};
use poneglyph_core::{Fact, SchemaDefinition, Uri, Value, Workspace};

use crate::cli::{SchemaCommand, SchemaSubcommand};
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: SchemaCommand,
) -> Result<()> {
    let schema = match daemon_client(&config).await {
        Ok(mut client) => {
            let json = client
                .get_schema(GetSchemaRequest {})
                .await?
                .into_inner()
                .json;
            serde_json::from_str::<SchemaDefinition>(&json)?
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            poneglyph.get_schema().await?
        }
    };

    match command.command {
        SchemaSubcommand::List { json } => print_schema_list(&schema, json),
        SchemaSubcommand::Get { uri: None, .. } => {
            println!("{}", serde_json::to_string_pretty(&schema)?);
            Ok(())
        }
        SchemaSubcommand::Get {
            uri: Some(uri),
            json,
        } => print_schema_entry(schema, &uri, json),
        SchemaSubcommand::Apply { path, json } => {
            let schema = read_schema_definition(&path).await?;
            let facts = schema_definition_to_facts(schema)?;
            let fact_count = facts.len();
            let tx_id = state_facts(&workspace, &config, facts).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "status": "applied",
                        "fact_count": fact_count,
                        "tx_id": tx_id,
                    }))?
                );
            } else {
                println!("applied {fact_count} schema facts in {tx_id}");
            }
            Ok(())
        }
    }
}

fn print_schema_list(schema: &SchemaDefinition, json: bool) -> Result<()> {
    if json {
        let entries = serde_json::json!({
            "namespaces": schema.namespaces.iter().map(|entry| entry.uri.as_str()).collect::<Vec<_>>(),
            "kinds": schema.kinds.iter().map(|entry| entry.uri.as_str()).collect::<Vec<_>>(),
            "fields": schema.fields.iter().map(|entry| entry.uri.as_str()).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&entries)?);
        return Ok(());
    }

    for namespace in &schema.namespaces {
        println!("namespace\t{}", namespace.uri);
    }
    for kind in &schema.kinds {
        println!("kind\t{}", kind.uri);
    }
    for field in &schema.fields {
        println!("field\t{}", field.uri);
    }
    Ok(())
}

async fn read_schema_definition(path: &Path) -> Result<SchemaDefinition> {
    let contents = tokio::fs::read_to_string(path).await?;
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("toml") => toml::from_str(&contents).map_err(Into::into),
        _ => serde_json::from_str(&contents).map_err(Into::into),
    }
}

fn schema_definition_to_facts(schema: SchemaDefinition) -> Result<Vec<Fact>> {
    let mut facts = Vec::new();

    for namespace in schema.namespaces {
        push_schema_entry_facts(
            &mut facts,
            namespace.uri,
            "schema:namespace",
            namespace.name,
            namespace.doc,
        )?;
    }

    for kind in schema.kinds {
        push_schema_entry_facts(&mut facts, kind.uri, "schema:kind", kind.name, kind.doc)?;
    }

    for field in schema.fields {
        let uri = field.uri;
        push_schema_entry_facts(
            &mut facts,
            uri.clone(),
            "schema:field",
            field.name,
            field.doc,
        )?;
        push_optional_reference_fact(&mut facts, &uri, "schema:sameAs", field.same_as)?;
        push_optional_reference_fact(&mut facts, &uri, "schema:field:domain", field.domain)?;
        push_optional_reference_fact(&mut facts, &uri, "schema:field:range", field.range)?;
        push_optional_text_fact(&mut facts, &uri, "schema:field:valueType", field.value_type)?;
        push_optional_text_fact(
            &mut facts,
            &uri,
            "schema:field:cardinality",
            field.cardinality,
        )?;
        push_optional_bool_fact(
            &mut facts,
            &uri,
            "schema:field:deprecated",
            field.deprecated,
        )?;
        push_optional_bool_fact(&mut facts, &uri, "schema:field:identity", field.identity)?;
    }

    Ok(facts)
}

fn push_schema_entry_facts(
    facts: &mut Vec<Fact>,
    uri: Uri,
    schema_type: &str,
    name: Option<String>,
    doc: Option<String>,
) -> Result<()> {
    facts.push(schema_fact(
        uri.clone(),
        "schema:type",
        Value::reference(parse_uri(schema_type)?),
    )?);
    push_optional_text_fact(facts, &uri, "schema:name", name)?;
    push_optional_text_fact(facts, &uri, "schema:doc", doc)?;
    Ok(())
}

fn push_optional_text_fact(
    facts: &mut Vec<Fact>,
    entity: &Uri,
    field: &str,
    value: Option<String>,
) -> Result<()> {
    if let Some(value) = value {
        facts.push(schema_fact(entity.clone(), field, Value::text(value))?);
    }
    Ok(())
}

fn push_optional_bool_fact(
    facts: &mut Vec<Fact>,
    entity: &Uri,
    field: &str,
    value: Option<bool>,
) -> Result<()> {
    if let Some(value) = value {
        facts.push(schema_fact(entity.clone(), field, Value::boolean(value))?);
    }
    Ok(())
}

fn push_optional_reference_fact(
    facts: &mut Vec<Fact>,
    entity: &Uri,
    field: &str,
    value: Option<Uri>,
) -> Result<()> {
    if let Some(value) = value {
        facts.push(schema_fact(entity.clone(), field, Value::reference(value))?);
    }
    Ok(())
}

fn schema_fact(entity: Uri, field: &str, value: Value) -> Result<Fact> {
    Ok(Fact::builder()
        .source(parse_uri("poneglyph:cli")?)
        .entity(entity)
        .field(parse_uri(field)?)
        .value(value)
        .build()?)
}

fn print_schema_entry(schema: SchemaDefinition, uri: &str, json: bool) -> Result<()> {
    let matches = serde_json::json!({
        "namespaces": schema.namespaces.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
        "kinds": schema.kinds.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
        "fields": schema.fields.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&matches)?);
    } else if matches["namespaces"]
        .as_array()
        .is_some_and(|entries| !entries.is_empty())
    {
        println!("namespace\t{uri}");
    } else if matches["kinds"]
        .as_array()
        .is_some_and(|entries| !entries.is_empty())
    {
        println!("kind\t{uri}");
    } else if matches["fields"]
        .as_array()
        .is_some_and(|entries| !entries.is_empty())
    {
        println!("field\t{uri}");
    } else {
        println!("not found\t{uri}");
    }
    Ok(())
}

async fn state_facts(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    facts: Vec<Fact>,
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => Ok(client
            .state_facts(StateFactsRequest {
                fact_json: facts
                    .iter()
                    .map(serde_json::to_string)
                    .collect::<Result<Vec<_>, _>>()?,
            })
            .await?
            .into_inner()
            .tx_id),
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            Ok(poneglyph.state_facts(facts).await?.to_string())
        }
    }
}

fn parse_uri(value: &str) -> Result<Uri> {
    Uri::parse(value.to_string()).map_err(Into::into)
}
