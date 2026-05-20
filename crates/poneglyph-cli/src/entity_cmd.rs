use anyhow::Result;
use poneglyph_api::{
    entity_from_proto,
    proto::{GetEntityRequest, ListEntitiesRequest, SearchEntitiesRequest},
    search_hit_from_proto,
};
use poneglyph_core::{Entity, SearchHit, Value, Workspace};

use crate::cli::{EntityCommand, EntitySubcommand};
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;
use crate::util::{parse_uri, usize_to_u64};

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: EntityCommand,
) -> Result<()> {
    match command.command {
        EntitySubcommand::List {
            limit,
            offset,
            json,
        } => {
            let response_json = list_entities_json(&workspace, &config, limit, offset).await?;
            print_entity_list(&response_json, json)?;
        }
        EntitySubcommand::Search { query, limit, json } => {
            let response_json = search_entities_json(&workspace, &config, &query, limit).await?;
            print_search_hits(&response_json, json)?;
        }
        EntitySubcommand::Get { uri, json } => {
            let response_json = get_entity_json(&workspace, &config, &uri).await?;
            print_entity(&response_json, json)?;
        }
    }
    Ok(())
}

async fn list_entities_json(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    limit: usize,
    offset: usize,
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let entities = client
                .list_entities_typed(ListEntitiesRequest {
                    limit: usize_to_u64(limit)?,
                    offset: usize_to_u64(offset)?,
                })
                .await?
                .into_inner()
                .entities
                .into_iter()
                .map(entity_from_proto)
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(anyhow::Error::msg)?;
            serde_json::to_string_pretty(&entities).map_err(Into::into)
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            serde_json::to_string_pretty(&poneglyph.list_entities(limit, offset).await?)
                .map_err(Into::into)
        }
    }
}

async fn search_entities_json(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    query: &str,
    limit: usize,
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let hits = client
                .search_entities_typed(SearchEntitiesRequest {
                    query: query.to_owned(),
                    limit: usize_to_u64(limit)?,
                })
                .await?
                .into_inner()
                .hits
                .into_iter()
                .map(search_hit_from_proto)
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(anyhow::Error::msg)?;
            serde_json::to_string_pretty(&hits).map_err(Into::into)
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            serde_json::to_string_pretty(&poneglyph.search(query, limit)?).map_err(Into::into)
        }
    }
}

async fn get_entity_json(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    uri: &str,
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => match client
            .get_entity_typed(GetEntityRequest {
                uri: uri.to_owned(),
            })
            .await?
            .into_inner()
            .entity
        {
            Some(entity) => serde_json::to_string_pretty(
                &entity_from_proto(entity).map_err(anyhow::Error::msg)?,
            )
            .map_err(Into::into),
            None => Ok("null".to_string()),
        },
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            match poneglyph.get_entity(&parse_uri(uri)?).await? {
                Some(entity) => serde_json::to_string_pretty(&entity).map_err(Into::into),
                None => Ok("null".to_string()),
            }
        }
    }
}

fn print_entity_list(response_json: &str, json: bool) -> Result<()> {
    if json {
        println!("{response_json}");
        return Ok(());
    }

    for line in plain_entity_list_lines(response_json)? {
        println!("{line}");
    }
    Ok(())
}

fn plain_entity_list_lines(response_json: &str) -> Result<Vec<String>> {
    let entities = serde_json::from_str::<Vec<Entity>>(response_json)?;
    if entities.is_empty() {
        Ok(vec!["no entities".to_string()])
    } else {
        Ok(entities
            .into_iter()
            .map(|entity| format!("entity\t{}", entity.uri))
            .collect())
    }
}

fn print_search_hits(response_json: &str, json: bool) -> Result<()> {
    if json {
        println!("{response_json}");
        return Ok(());
    }

    for line in plain_search_hit_lines(response_json)? {
        println!("{line}");
    }
    Ok(())
}

fn plain_search_hit_lines(response_json: &str) -> Result<Vec<String>> {
    let hits = serde_json::from_str::<Vec<SearchHit>>(response_json)?;
    if hits.is_empty() {
        Ok(vec!["no results".to_string()])
    } else {
        Ok(hits
            .into_iter()
            .map(|hit| format!("hit\t{}\t{}", hit.entity_uri, hit.score))
            .collect())
    }
}

fn print_entity(response_json: &str, json: bool) -> Result<()> {
    if json {
        println!("{response_json}");
        return Ok(());
    }

    for line in plain_entity_lines(response_json)? {
        println!("{line}");
    }
    Ok(())
}

fn plain_entity_lines(response_json: &str) -> Result<Vec<String>> {
    if response_json.trim() == "null" {
        return Ok(vec!["not found".to_string()]);
    }

    let entity = serde_json::from_str::<Entity>(response_json)?;
    let mut lines = vec![format!("entity\t{}", entity.uri)];
    for (field, value) in entity.fields {
        lines.push(format!("field\t{}\t{}", field, value_json(&value)?));
    }
    Ok(lines)
}

fn value_json(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use poneglyph_core::{Entity, SearchHit, Value};

    use super::{plain_entity_lines, plain_entity_list_lines, plain_search_hit_lines};
    use crate::util::parse_uri;

    #[test]
    fn plain_entity_list_lines_formats_entities_and_empty_lists() {
        let entity = Entity {
            uri: parse_uri("spotify:album:signals").expect("entity uri"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields: BTreeMap::new(),
        };
        let json = serde_json::to_string(&vec![entity]).expect("json");

        assert_eq!(
            plain_entity_list_lines(&json).expect("lines"),
            vec!["entity\tspotify:album:signals"]
        );
        assert_eq!(
            plain_entity_list_lines("[]").expect("empty lines"),
            vec!["no entities"]
        );
    }

    #[test]
    fn plain_search_hit_lines_formats_hits_and_empty_results() {
        let hit = SearchHit {
            entity_uri: parse_uri("spotify:album:signals").expect("entity uri"),
            score: 1.5,
        };
        let json = serde_json::to_string(&vec![hit]).expect("json");

        assert_eq!(
            plain_search_hit_lines(&json).expect("lines"),
            vec!["hit\tspotify:album:signals\t1.5"]
        );
        assert_eq!(
            plain_search_hit_lines("[]").expect("empty lines"),
            vec!["no results"]
        );
    }

    #[test]
    fn plain_entity_lines_formats_fields_and_nulls() {
        let mut fields = BTreeMap::new();
        fields.insert(
            parse_uri("spotify:displayName").expect("field uri"),
            Value::text("Signals"),
        );
        let entity = Entity {
            uri: parse_uri("spotify:album:signals").expect("entity uri"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields,
        };
        let json = serde_json::to_string(&entity).expect("json");

        assert_eq!(
            plain_entity_lines(&json).expect("lines"),
            vec![
                "entity\tspotify:album:signals".to_string(),
                "field\tspotify:displayName\t{\"type\":\"text\",\"value\":\"Signals\"}".to_string(),
            ]
        );
        assert_eq!(plain_entity_lines("null").expect("null"), vec!["not found"]);
    }
}
