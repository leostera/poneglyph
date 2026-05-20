use anyhow::Result;
use poneglyph_api::proto::{GetEntityRequest, ListEntitiesRequest, SearchEntitiesRequest};
use poneglyph_core::{Entity, SearchHit, Workspace};

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
            let response_json = match daemon_client(&config).await {
                Ok(mut client) => {
                    client
                        .list_entities(ListEntitiesRequest {
                            limit: usize_to_u64(limit)?,
                            offset: usize_to_u64(offset)?,
                        })
                        .await?
                        .into_inner()
                        .json
                }
                Err(_) => {
                    let poneglyph = open_runtime(workspace, config).await?;
                    serde_json::to_string_pretty(&poneglyph.list_entities(limit, offset).await?)?
                }
            };
            print_entity_list(&response_json, json)?;
        }
        EntitySubcommand::Search { query, limit, json } => {
            let response_json = match daemon_client(&config).await {
                Ok(mut client) => {
                    client
                        .search_entities(SearchEntitiesRequest {
                            query,
                            limit: usize_to_u64(limit)?,
                        })
                        .await?
                        .into_inner()
                        .json
                }
                Err(_) => {
                    let poneglyph = open_runtime(workspace, config).await?;
                    serde_json::to_string_pretty(&poneglyph.search(&query, limit)?)?
                }
            };
            print_search_hits(&response_json, json)?;
        }
        EntitySubcommand::Get { uri, json } => {
            let response_json = match daemon_client(&config).await {
                Ok(mut client) => {
                    client
                        .get_entity(GetEntityRequest { uri })
                        .await?
                        .into_inner()
                        .json
                }
                Err(_) => {
                    let poneglyph = open_runtime(workspace, config).await?;
                    match poneglyph.get_entity(&parse_uri(&uri)?).await? {
                        Some(entity) => serde_json::to_string_pretty(&entity)?,
                        None => "null".to_string(),
                    }
                }
            };
            print_entity(&response_json, json)?;
        }
    }
    Ok(())
}

fn print_entity_list(response_json: &str, json: bool) -> Result<()> {
    if json {
        println!("{response_json}");
        return Ok(());
    }

    let entities = serde_json::from_str::<Vec<Entity>>(response_json)?;
    if entities.is_empty() {
        println!("no entities");
    } else {
        for entity in entities {
            println!("entity\t{}", entity.uri);
        }
    }
    Ok(())
}

fn print_search_hits(response_json: &str, json: bool) -> Result<()> {
    if json {
        println!("{response_json}");
        return Ok(());
    }

    let hits = serde_json::from_str::<Vec<SearchHit>>(response_json)?;
    if hits.is_empty() {
        println!("no results");
    } else {
        for hit in hits {
            println!("hit\t{}\t{}", hit.entity_uri, hit.score);
        }
    }
    Ok(())
}

fn print_entity(response_json: &str, json: bool) -> Result<()> {
    if json {
        println!("{response_json}");
        return Ok(());
    }

    if response_json.trim() == "null" {
        println!("not found");
        return Ok(());
    }

    let entity = serde_json::from_str::<Entity>(response_json)?;
    println!("entity\t{}", entity.uri);
    for (field, value) in entity.fields {
        println!("field\t{}\t{}", field, serde_json::to_string(&value)?);
    }
    Ok(())
}
