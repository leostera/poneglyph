use std::path::Path;

use anyhow::Result;
use poneglyph_api::proto::{GetSchemaRequest, StateFactsRequest};
use poneglyph_core::{Fact, SchemaDefinition, Uri, Value, Workspace};

use crate::cli::{SchemaCommand, SchemaSubcommand};
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;
use crate::util::parse_uri;

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: SchemaCommand,
) -> Result<()> {
    match command.command {
        SchemaSubcommand::List { json } => {
            let schema = get_schema(&workspace, &config).await?;
            print_schema_list(&schema, json)
        }
        SchemaSubcommand::Get { uri: None, .. } => {
            let schema = get_schema(&workspace, &config).await?;
            println!("{}", serde_json::to_string_pretty(&schema)?);
            Ok(())
        }
        SchemaSubcommand::Get {
            uri: Some(uri),
            json,
        } => {
            let schema = get_schema(&workspace, &config).await?;
            print_schema_entry(schema, &uri, json)
        }
        SchemaSubcommand::Apply { path, json } => {
            let schema = read_schema_definition(&path).await?;
            let facts = schema_definition_to_facts(schema)?;
            let fact_count = facts.len();
            let tx_id = state_facts(&workspace, &config, facts).await?;
            print_schema_apply_outcome(fact_count, &tx_id, json)
        }
    }
}

async fn get_schema(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
) -> Result<SchemaDefinition> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let json = client
                .get_schema(GetSchemaRequest {})
                .await?
                .into_inner()
                .json;
            serde_json::from_str(&json).map_err(Into::into)
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            poneglyph.get_schema().await.map_err(Into::into)
        }
    }
}

fn print_schema_list(schema: &SchemaDefinition, json: bool) -> Result<()> {
    if json {
        println!("{}", schema_list_json(schema)?);
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

fn print_schema_apply_outcome(fact_count: usize, tx_id: &str, json: bool) -> Result<()> {
    if json {
        println!("{}", schema_apply_json(fact_count, tx_id)?);
    } else {
        println!("applied {fact_count} schema facts in {tx_id}");
    }
    Ok(())
}

fn schema_list_json(schema: &SchemaDefinition) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "namespaces": schema.namespaces.iter().map(|entry| entry.uri.as_str()).collect::<Vec<_>>(),
        "kinds": schema.kinds.iter().map(|entry| entry.uri.as_str()).collect::<Vec<_>>(),
        "fields": schema.fields.iter().map(|entry| entry.uri.as_str()).collect::<Vec<_>>(),
    }))
    .map_err(Into::into)
}

fn schema_apply_json(fact_count: usize, tx_id: &str) -> Result<String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "status": "applied",
        "fact_count": fact_count,
        "tx_id": tx_id,
    }))
    .map_err(Into::into)
}

fn schema_entry_matches(schema: SchemaDefinition, uri: &str) -> serde_json::Value {
    serde_json::json!({
        "namespaces": schema.namespaces.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
        "kinds": schema.kinds.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
        "fields": schema.fields.into_iter().filter(|entry| entry.uri.as_str() == uri).collect::<Vec<_>>(),
    })
}

fn print_schema_entry(schema: SchemaDefinition, uri: &str, json: bool) -> Result<()> {
    let matches = schema_entry_matches(schema, uri);
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

#[cfg(test)]
mod tests {
    use poneglyph_core::{FieldSchema, NamespaceSchema, SchemaDefinition};

    use super::{schema_apply_json, schema_entry_matches, schema_list_json};
    use crate::util::parse_uri;

    #[test]
    fn schema_list_json_summarizes_entry_uris() {
        let schema = SchemaDefinition {
            namespaces: vec![NamespaceSchema {
                uri: parse_uri("spotify:namespace").expect("uri"),
                name: Some("Spotify".to_string()),
                doc: None,
            }],
            fields: vec![FieldSchema {
                uri: parse_uri("spotify:displayName").expect("uri"),
                name: None,
                doc: None,
                same_as: None,
                domain: None,
                range: None,
                value_type: None,
                cardinality: None,
                deprecated: None,
                identity: None,
            }],
            ..Default::default()
        };

        let json = schema_list_json(&schema).expect("schema list json");

        assert!(json.contains(r#""namespaces": ["#));
        assert!(json.contains(r#""spotify:namespace""#));
        assert!(json.contains(r#""spotify:displayName""#));
    }

    #[test]
    fn schema_entry_matches_filters_by_uri() {
        let schema = SchemaDefinition {
            namespaces: vec![NamespaceSchema {
                uri: parse_uri("spotify:namespace").expect("uri"),
                name: None,
                doc: None,
            }],
            ..Default::default()
        };

        let matches = schema_entry_matches(schema, "spotify:namespace");

        assert_eq!(
            matches["namespaces"].as_array().expect("namespaces").len(),
            1
        );
        assert!(matches["kinds"].as_array().expect("kinds").is_empty());
        assert!(matches["fields"].as_array().expect("fields").is_empty());
    }

    #[test]
    fn schema_apply_json_reports_status_count_and_tx() {
        let json = schema_apply_json(3, "poneglyph:tx:abc").expect("apply json");

        assert!(json.contains(r#""status": "applied""#));
        assert!(json.contains(r#""fact_count": 3"#));
        assert!(json.contains(r#""tx_id": "poneglyph:tx:abc""#));
    }
}
