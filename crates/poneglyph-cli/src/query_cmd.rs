use anyhow::Result;
use poneglyph_api::proto::{QueryRequest, QueryResponse, query_value};
use poneglyph_core::Workspace;
use serde_json::Value as JsonValue;

use crate::cli::QueryCommand;
use crate::client::{daemon_client, open_runtime};
use crate::config::PoneglyphDaemonConfig;

pub async fn run(
    workspace: Workspace,
    config: PoneglyphDaemonConfig,
    command: QueryCommand,
) -> Result<()> {
    let json = query_json(&workspace, &config, &command.expression).await?;
    if command.json {
        println!("{json}");
    } else {
        print_plain_query_results(&json)?;
    }
    Ok(())
}

async fn query_json(
    workspace: &Workspace,
    config: &PoneglyphDaemonConfig,
    expression: &str,
) -> Result<String> {
    match daemon_client(config).await {
        Ok(mut client) => {
            let response = client
                .query_typed(QueryRequest {
                    expression: expression.to_owned(),
                })
                .await?
                .into_inner();
            query_response_json(response)
        }
        Err(_) => {
            let poneglyph = open_runtime(workspace.clone(), config.clone()).await?;
            let result = poneglyph.query_str(expression).await?;
            serde_json::to_string_pretty(result.substitutions()).map_err(Into::into)
        }
    }
}

fn query_response_json(response: QueryResponse) -> Result<String> {
    let rows = response
        .rows
        .into_iter()
        .map(|row| {
            let bindings = row
                .bindings
                .into_iter()
                .map(|binding| {
                    let value = match binding.value.and_then(|value| value.kind) {
                        Some(query_value::Kind::Integer(value)) => {
                            serde_json::json!({"Integer": value})
                        }
                        Some(query_value::Kind::String(value)) => {
                            serde_json::json!({"String": value})
                        }
                        None => serde_json::Value::Null,
                    };
                    (binding.variable, value)
                })
                .collect::<serde_json::Map<_, _>>();
            serde_json::json!({ "bindings": bindings })
        })
        .collect::<Vec<_>>();

    serde_json::to_string_pretty(&rows).map_err(Into::into)
}

fn print_plain_query_results(json: &str) -> Result<()> {
    let rows = plain_query_rows(json)?;
    if rows.is_empty() {
        println!("no results");
    } else {
        for row in rows {
            println!("{row}");
        }
    }
    Ok(())
}

fn plain_query_rows(json: &str) -> Result<Vec<String>> {
    let value = serde_json::from_str::<JsonValue>(json)?;
    let rows = value
        .as_array()
        .map(|rows| rows.iter().map(plain_query_row).collect())
        .unwrap_or_else(|| vec![format!("row\t{}", compact_json(&value))]);

    Ok(rows)
}

fn plain_query_row(row: &JsonValue) -> String {
    let bindings = row
        .get("bindings")
        .and_then(JsonValue::as_object)
        .into_iter()
        .flat_map(|bindings| bindings.iter())
        .map(|(variable, value)| format!("{variable}={}", plain_query_value(value)))
        .collect::<Vec<_>>();

    if bindings.is_empty() {
        "row\t{}".to_string()
    } else {
        format!("row\t{}", bindings.join("\t"))
    }
}

fn plain_query_value(value: &JsonValue) -> String {
    if let Some(value) = value.get("String") {
        return compact_json(value);
    }
    if let Some(value) = value.get("Integer") {
        return compact_json(value);
    }

    compact_json(value)
}

fn compact_json(value: &JsonValue) -> String {
    serde_json::to_string(value).expect("serializing serde_json::Value cannot fail")
}

#[cfg(test)]
mod tests {
    use poneglyph_api::proto::{QueryBinding, QueryResponse, QueryRow, QueryValue, query_value};

    use super::{plain_query_rows, query_response_json};

    #[test]
    fn query_response_json_matches_legacy_substitution_shape() {
        let json = query_response_json(QueryResponse {
            rows: vec![QueryRow {
                bindings: vec![
                    QueryBinding {
                        variable: "Album".to_string(),
                        value: Some(QueryValue {
                            kind: Some(query_value::Kind::String("spotify:album:2112".to_string())),
                        }),
                    },
                    QueryBinding {
                        variable: "Year".to_string(),
                        value: Some(QueryValue {
                            kind: Some(query_value::Kind::Integer(1976)),
                        }),
                    },
                ],
            }],
        })
        .expect("query json");

        assert_eq!(
            plain_query_rows(&json).expect("plain rows"),
            vec!["row\tAlbum=\"spotify:album:2112\"\tYear=1976"]
        );
    }

    #[test]
    fn plain_query_rows_formats_bindings() {
        let rows = plain_query_rows(
            r#"[
              {"bindings":{"Album":{"String":"spotify:album:2112"},"Year":{"Integer":1976}}}
            ]"#,
        )
        .expect("plain rows");

        assert_eq!(rows, vec!["row\tAlbum=\"spotify:album:2112\"\tYear=1976"]);
    }

    #[test]
    fn plain_query_rows_keeps_empty_result_empty() {
        let rows = plain_query_rows("[]").expect("plain rows");

        assert!(rows.is_empty());
    }

    #[test]
    fn plain_query_rows_formats_unexpected_json_payloads() {
        let rows = plain_query_rows(r#"{"status":"ok"}"#).expect("plain rows");

        assert_eq!(rows, vec![r#"row	{"status":"ok"}"#]);
    }
}
