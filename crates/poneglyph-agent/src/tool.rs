use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use agents::error::{Error as LlmError, LlmResult};
use agents::tools::RawToolDefinition;
use agents::{AgentResult, ToolCallEnvelope, ToolExecutionResult, ToolResultEnvelope, ToolRunner};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use poneglyph::{Entity, Fact, Poneglyph, Uri, Value, fact, uri};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateEntityArgs {
    pub namespace: String,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SearchEntitiesArgs {
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReadEntityArgs {
    pub entity_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct QueryFactsArgs {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StateFactsArgs {
    pub entities: Vec<String>,
    pub facts: Vec<FactInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FactInput {
    pub source: Option<String>,
    pub entity: String,
    pub field: String,
    pub value: ValueInput,
    #[serde(default)]
    pub retraction: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ValueInput {
    Null,
    Text(String),
    Number(String),
    Boolean(bool),
    Bytes(Vec<u8>),
    Reference(String),
    Date(#[schemars(with = "String")] NaiveDate),
    DateTime(#[schemars(with = "String")] DateTime<Utc>),
    List(Vec<ValueInput>),
    Map(BTreeMap<String, ValueInput>),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub enum PoneglyphTool {
    CreateEntity(CreateEntityArgs),
    GetSchema,
    SearchEntities(SearchEntitiesArgs),
    ReadEntity(ReadEntityArgs),
    QueryFacts(QueryFactsArgs),
    StateFacts(StateFactsArgs),
}

impl agents::tools::TypedTool for PoneglyphTool {
    fn tool_definitions() -> Vec<RawToolDefinition> {
        vec![
            RawToolDefinition::function(
                "create_entity",
                Some(
                    "Create a new entity URI and state its schema:name. Use this only after searching first and failing to find an existing entity.",
                ),
                schema_for::<CreateEntityArgs>(),
            ),
            RawToolDefinition::function(
                "get_schema",
                Some(
                    "Fetch the effective schema definition from Poneglyph. Use this before reasoning about namespaces, kinds, or fields you are unsure about.",
                ),
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            ),
            RawToolDefinition::function(
                "search_entities",
                Some(
                    "Search the knowledge graph for existing entities. Use this before inventing new URIs or stating facts about a thing that may already exist.",
                ),
                schema_for::<SearchEntitiesArgs>(),
            ),
            RawToolDefinition::function(
                "read_entity",
                Some("Read one consolidated entity by URI."),
                schema_for::<ReadEntityArgs>(),
            ),
            RawToolDefinition::function(
                "query_facts",
                Some("Run a Datafox query over the active graph facts."),
                schema_for::<QueryFactsArgs>(),
            ),
            RawToolDefinition::function(
                "state_facts",
                Some(
                    "Append one atomic batch of facts. Prefer create_entity or search_entities before using this when the entity identity is not already known.",
                ),
                state_facts_schema(),
            ),
        ]
    }

    fn decode_tool_call(name: &str, arguments: JsonValue) -> LlmResult<Self> {
        match name {
            "create_entity" => decode::<CreateEntityArgs>(name, arguments).map(Self::CreateEntity),
            "get_schema" => Ok(Self::GetSchema),
            "search_entities" => {
                decode::<SearchEntitiesArgs>(name, arguments).map(Self::SearchEntities)
            }
            "read_entity" => decode::<ReadEntityArgs>(name, arguments).map(Self::ReadEntity),
            "query_facts" => decode::<QueryFactsArgs>(name, arguments).map(Self::QueryFacts),
            "state_facts" => decode::<StateFactsArgs>(name, arguments).map(Self::StateFacts),
            other => Err(LlmError::InvalidResponse {
                reason: format!("unexpected tool name: {other}"),
            }),
        }
    }
}

#[derive(Clone)]
pub struct PoneglyphToolRunner {
    poneglyph: Arc<Poneglyph>,
}

impl PoneglyphToolRunner {
    pub fn new(poneglyph: Arc<Poneglyph>) -> Self {
        Self { poneglyph }
    }
}

#[async_trait]
impl ToolRunner<PoneglyphTool, JsonValue> for PoneglyphToolRunner {
    async fn run(
        &self,
        call: ToolCallEnvelope<PoneglyphTool>,
    ) -> AgentResult<ToolResultEnvelope<JsonValue>> {
        let result = match call.call.clone() {
            PoneglyphTool::CreateEntity(args) => self.create_entity(args).await,
            PoneglyphTool::GetSchema => self.get_schema().await,
            PoneglyphTool::SearchEntities(args) => self.search_entities(args).await,
            PoneglyphTool::ReadEntity(args) => self.read_entity(args).await,
            PoneglyphTool::QueryFacts(args) => self.query_facts(args).await,
            PoneglyphTool::StateFacts(args) => self.state_facts(args).await,
        };

        Ok(ToolResultEnvelope {
            call_id: call.call_id,
            result: match result {
                Ok(data) => ToolExecutionResult::Ok { data },
                Err(error) => ToolExecutionResult::Error {
                    message: error.to_string(),
                },
            },
        })
    }
}

impl PoneglyphToolRunner {
    async fn create_entity(&self, args: CreateEntityArgs) -> anyhow::Result<JsonValue> {
        let entity_uri = uri!(args.namespace.as_str(), args.kind.as_str());
        let tx_id = self
            .poneglyph
            .state_facts(vec![fact!(
                uri!("poneglyph:agent"),
                entity_uri.clone(),
                uri!("schema:name"),
                Value::text(args.name)
            )])
            .await?;
        Ok(json!({
            "entityUri": entity_uri.to_string(),
            "txId": tx_id.to_string(),
        }))
    }

    async fn get_schema(&self) -> anyhow::Result<JsonValue> {
        Ok(serde_json::to_value(self.poneglyph.get_schema().await?)?)
    }

    async fn search_entities(&self, args: SearchEntitiesArgs) -> anyhow::Result<JsonValue> {
        let limit = args.limit.unwrap_or(10).max(1);
        let mut hits = Vec::new();

        for hit in self.poneglyph.search(&args.query, limit)? {
            let entity = self.poneglyph.get_entity(&hit.entity_uri).await?;
            hits.push(json!({
                "entityUri": hit.entity_uri.to_string(),
                "score": hit.score,
                "label": entity.as_ref().and_then(entity_label),
                "namespace": entity.as_ref().map(|entity| entity.namespace.clone()),
                "kind": entity.as_ref().map(|entity| entity.kind.clone()),
            }));
        }

        Ok(json!({ "hits": hits }))
    }

    async fn read_entity(&self, args: ReadEntityArgs) -> anyhow::Result<JsonValue> {
        let entity_uri = Uri::parse(args.entity_uri)?;
        Ok(json!({
            "entity": self.poneglyph.get_entity(&entity_uri).await?,
        }))
    }

    async fn query_facts(&self, args: QueryFactsArgs) -> anyhow::Result<JsonValue> {
        let substitutions = self.poneglyph.query_str(&args.query).await?;
        Ok(json!({
            "substitutions": substitutions.into_substitutions(),
        }))
    }

    async fn state_facts(&self, args: StateFactsArgs) -> anyhow::Result<JsonValue> {
        let entities: HashSet<Uri> = args
            .entities
            .into_iter()
            .map(Uri::parse)
            .collect::<Result<_, _>>()?;
        let facts: Vec<Fact> = args
            .facts
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<_, _>>()?;

        for fact in &facts {
            if !entities.contains(&fact.entity) {
                anyhow::bail!(
                    "fact references entity `{}` not declared in entities",
                    fact.entity
                );
            }
        }

        let tx_id = self.poneglyph.state_facts(facts).await?;
        Ok(json!({ "txId": tx_id.to_string() }))
    }
}

impl TryFrom<FactInput> for Fact {
    type Error = poneglyph::Error;

    fn try_from(input: FactInput) -> Result<Self, Self::Error> {
        let source = match input.source {
            Some(source) => Uri::parse(source)?,
            None => uri!("poneglyph:agent"),
        };
        let builder = Fact::builder()
            .source(source)
            .entity(Uri::parse(input.entity)?)
            .field(Uri::parse(input.field)?)
            .value(input.value.try_into()?);
        let builder = if input.retraction {
            builder.retract()
        } else {
            builder.assert()
        };
        builder.build()
    }
}

impl TryFrom<ValueInput> for Value {
    type Error = poneglyph::Error;

    fn try_from(value: ValueInput) -> Result<Self, Self::Error> {
        Ok(match value {
            ValueInput::Null => Value::Null,
            ValueInput::Text(value) => Value::Text(value),
            ValueInput::Number(value) => Value::Number(value),
            ValueInput::Boolean(value) => Value::Boolean(value),
            ValueInput::Bytes(value) => Value::Bytes(value),
            ValueInput::Reference(value) => Value::Reference(Uri::parse(value)?),
            ValueInput::Date(value) => Value::Date(value),
            ValueInput::DateTime(value) => Value::DateTime(value),
            ValueInput::List(values) => Value::List(
                values
                    .into_iter()
                    .map(TryInto::try_into)
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            ValueInput::Map(values) => Value::Map(
                values
                    .into_iter()
                    .map(|(key, value)| value.try_into().map(|value| (key, value)))
                    .collect::<Result<_, _>>()?,
            ),
        })
    }
}

fn decode<T>(subject: &str, arguments: JsonValue) -> LlmResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(arguments).map_err(|error| LlmError::parse(subject, error))
}

fn entity_label(entity: &Entity) -> Option<String> {
    entity
        .fields
        .iter()
        .find_map(|(field, value)| {
            if field.as_str() == "schema:name" {
                match value {
                    Value::Text(text) => Some(text.clone()),
                    _ => None,
                }
            } else {
                None
            }
        })
        .or_else(|| {
            entity.fields.iter().find_map(|(_, value)| match value {
                Value::Text(text) => Some(text.clone()),
                _ => None,
            })
        })
}

fn schema_for<T: JsonSchema>() -> JsonValue {
    serde_json::to_value(schemars::schema_for!(T)).expect("json schema")
}

fn state_facts_schema() -> JsonValue {
    json!({
        "type": "object",
        "properties": {
            "entities": {
                "type": "array",
                "description": "Entity URIs that this fact batch is allowed to reference.",
                "items": { "type": "string" }
            },
            "facts": {
                "type": "array",
                "description": "Facts to append in one atomic batch.",
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {
                            "type": "string",
                            "description": "Optional source URI. If omitted, poneglyph:agent is used."
                        },
                        "entity": {
                            "type": "string",
                            "description": "Entity URI receiving the fact."
                        },
                        "field": {
                            "type": "string",
                            "description": "Field URI for the fact."
                        },
                        "value": {
                            "type": "object",
                            "description": "Poneglyph value encoded as { type, value }. Supported types: null, text, number, boolean, bytes, reference, date, date_time, list, map. For null, omit value. For list, value is an array of nested encoded values. For map, value is an object whose property values are nested encoded values.",
                            "properties": {
                                "type": {
                                    "type": "string",
                                    "enum": [
                                        "null",
                                        "text",
                                        "number",
                                        "boolean",
                                        "bytes",
                                        "reference",
                                        "date",
                                        "date_time",
                                        "list",
                                        "map"
                                    ]
                                },
                                "value": {
                                    "description": "Variant payload. Use a string for text, number, reference, date, and date_time; a boolean for boolean; an array of integers for bytes; an array of nested values for list; and an object whose values are nested values for map."
                                }
                            },
                            "required": ["type"],
                            "additionalProperties": false
                        },
                        "retraction": {
                            "type": "boolean",
                            "description": "When true, the fact is appended as a retraction.",
                            "default": false
                        }
                    },
                    "required": ["entity", "field", "value"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["entities", "facts"],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use agents::tools::TypedTool;
    use serde_json::Value as JsonValue;

    use super::PoneglyphTool;

    #[test]
    fn state_facts_schema_avoids_one_of() {
        let schema = PoneglyphTool::tool_definitions()
            .into_iter()
            .find(|definition| definition.function.name == "state_facts")
            .expect("state_facts tool definition")
            .function
            .parameters;

        assert!(
            !contains_one_of(&schema),
            "state_facts schema must not use oneOf because OpenAI function schemas reject it"
        );
    }

    fn contains_one_of(value: &JsonValue) -> bool {
        match value {
            JsonValue::Object(object) => {
                object.contains_key("oneOf") || object.values().any(contains_one_of)
            }
            JsonValue::Array(values) => values.iter().any(contains_one_of),
            _ => false,
        }
    }
}
