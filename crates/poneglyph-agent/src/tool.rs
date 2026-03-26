use std::collections::HashSet;
use std::sync::Arc;

use agents::error::{Error as LlmError, LlmResult};
use agents::tools::RawToolDefinition;
use agents::{AgentResult, ToolCallEnvelope, ToolExecutionResult, ToolResultEnvelope, ToolRunner};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use datafox::Value as DatafoxValue;
use poneglyph::{Entity, Fact, Poneglyph, Uri, Value, fact, uri};
use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};

pub const CREATE_ENTITY_TOOL_DESCRIPTION: &str = r#"Create a new entity URI and immediately state its `schema:name`.

Use this only after you have searched first and confirmed the entity does not already exist.

Example:
{
  "namespace": "dev",
  "kind": "project",
  "name": "poneglyph"
}

Returns:
{
  "entityUri": "dev:project:032HJb6y7SlDSWhok7W2QC",
  "txId": "poneglyph:tx:..."
}"#;

pub const STATE_FACTS_TOOL_DESCRIPTION: &str = r#"Append one atomic batch of facts.

All entity URIs used by `facts[*].entity` must also appear in `entities`.
Use `get_schema` first when you need to discover or extend the graph vocabulary.
Use `create_entity` or `search_entities` to find or create entities before writing facts.

Example:
{
  "entities": ["spotify:artist:rush"],
  "facts": [
    {
      "entity": "spotify:artist:rush",
      "field": "spotify:displayName",
      "value": { "type": "text", "text": "Rush" }
    }
  ]
}"#;

pub const QUERY_FACTS_TOOL_DESCRIPTION: &str = r#"Run a Datafox query over the active graph facts.

Use `get_schema` first to discover the real namespaces, kinds, and field URIs.
Never invent predicates like `spotify:event:week` or other helper functions that are not present in schema.
This is the only free-form graph query tool. There is no `query_entities` tool, no SPARQL, and no SQL.
Do not emit tool-call JSON in assistant text. Call `query_facts` directly.

Supported grammar:
query        = clause , { "," , clause } ;
clause       = [ "!" ] , predicate , "(" , term , { "," , term } , ")" ;
predicate    = identifier | quoted_predicate ;
identifier   = ? unquoted predicate like spotify:displayName ? ;
quoted_predicate = "'" , { character } , "'" | '"' , { character } , '"' ;
term         = variable | "_" | string | integer ;
variable     = ? identifier starting with uppercase letter ? ;

Examples:
spotify:displayName(Album, "2112")
spotify:byArtist(Album, Artist), spotify:displayName(Artist, "Rush")
schema:name(Entity, Name)
gcal:startAt(Event, Start), Start >= "2026-03-23", Start < "2026-03-30", schema:name(Event, Name)

If the question is about a time window:
1. bind the relevant time field to a variable
2. filter it with `>`, `>=`, `<`, or `<=`
3. project names or identifiers with ordinary field clauses"#;

pub const QUERY_ENTITIES_TOOL_DESCRIPTION: &str = r#"Query entities of a specific kind with a simple structured filter.

Prefer this after `get_schema` when the task is "find entities of kind X whose field values fall in a range".
This tool is easier than raw `query_facts` for common lookups.

Supported filter format:
- clauses joined with `AND`
- each clause is `field OP "value"`
- supported operators are `=`, `>`, `>=`, `<`, `<=`

Example:
{
  "type": "gcal:event",
  "filter": "gcal:startAt >= \"2026-03-23\" AND gcal:startAt <= \"2026-03-29\"",
  "limit": 10
}

Do not use SPARQL or SQL here. Use real field URIs from `get_schema`."#;

pub const GET_SCHEMA_TOOL_DESCRIPTION: &str = r#"Fetch the effective schema definition built from ordinary schema facts and observed data.

Use this before querying or writing new schema so you can discover:
- namespaces
- kinds
- fields
- field domains, ranges, and value types when available

After reading schema, use the real field URIs you found there with `query_facts`.
Do not invent other query tools.

Example:
{}"#;

pub const READ_ENTITY_TOOL_DESCRIPTION: &str = r#"Fetch a consolidated entity by URI.

Example:
{
  "entity_uri": "spotify:artist:rush"
}"#;

pub const SEARCH_ENTITIES_TOOL_DESCRIPTION: &str = r#"Search the projected entity index for existing entities.

Use this before inventing new URIs or stating facts about a thing that may already exist.
This is text search over projected entities, not a structured date/filter query tool.

Example:
{
  "query": "rush",
  "limit": 5
}"#;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateEntityArgs {
    pub namespace: String,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchEntitiesArgs {
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadEntityArgs {
    pub entity_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QueryFactsArgs {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QueryEntitiesArgs {
    #[serde(rename = "type", alias = "kind")]
    pub entity_type: String,
    pub filter: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StateFactsArgs {
    pub entities: Vec<String>,
    pub facts: Vec<FactInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FactInput {
    pub source: Option<String>,
    pub entity: String,
    pub field: String,
    pub value: ValueInput,
    #[serde(default)]
    pub retraction: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ValueInputKind {
    Null,
    Text,
    Number,
    Boolean,
    Bytes,
    Reference,
    Date,
    DateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ValueInput {
    #[serde(rename = "type")]
    pub kind: ValueInputKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boolean: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    pub date: Option<NaiveDate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    pub date_time: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub enum PoneglyphTool {
    CreateEntity(CreateEntityArgs),
    GetSchema,
    SearchEntities(SearchEntitiesArgs),
    ReadEntity(ReadEntityArgs),
    QueryFacts(QueryFactsArgs),
    QueryEntities(QueryEntitiesArgs),
    StateFacts(StateFactsArgs),
}

impl agents::tools::TypedTool for PoneglyphTool {
    fn tool_definitions() -> Vec<RawToolDefinition> {
        vec![
            RawToolDefinition::function(
                "create_entity",
                Some(CREATE_ENTITY_TOOL_DESCRIPTION),
                schema_for::<CreateEntityArgs>(),
            ),
            RawToolDefinition::function(
                "get_schema",
                Some(GET_SCHEMA_TOOL_DESCRIPTION),
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            ),
            RawToolDefinition::function(
                "search_entities",
                Some(SEARCH_ENTITIES_TOOL_DESCRIPTION),
                schema_for::<SearchEntitiesArgs>(),
            ),
            RawToolDefinition::function(
                "read_entity",
                Some(READ_ENTITY_TOOL_DESCRIPTION),
                schema_for::<ReadEntityArgs>(),
            ),
            RawToolDefinition::function(
                "query_facts",
                Some(QUERY_FACTS_TOOL_DESCRIPTION),
                schema_for::<QueryFactsArgs>(),
            ),
            RawToolDefinition::function(
                "query_entities",
                Some(QUERY_ENTITIES_TOOL_DESCRIPTION),
                schema_for::<QueryEntitiesArgs>(),
            ),
            RawToolDefinition::function(
                "state_facts",
                Some(STATE_FACTS_TOOL_DESCRIPTION),
                schema_for::<StateFactsArgs>(),
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
            "query_entities" => {
                decode::<QueryEntitiesArgs>(name, arguments).map(Self::QueryEntities)
            }
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
            PoneglyphTool::QueryEntities(args) => self.query_entities(args).await,
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

    async fn query_entities(&self, args: QueryEntitiesArgs) -> anyhow::Result<JsonValue> {
        let query = build_query_entities_query(&args)?;
        let substitutions = self.poneglyph.query_str(&query).await?;
        let limit = args.limit.unwrap_or(10).max(1);
        let mut entities = Vec::new();

        for entity_uri in entity_uris_from_substitutions(&substitutions.into_substitutions(), limit)
        {
            let entity = self.poneglyph.get_entity(&entity_uri).await?;
            entities.push(json!({
                "entityUri": entity_uri.to_string(),
                "label": entity.as_ref().and_then(entity_label),
                "entity": entity,
            }));
        }

        Ok(json!({
            "query": query,
            "entities": entities,
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
    type Error = anyhow::Error;

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
        Ok(builder.build()?)
    }
}

impl TryFrom<ValueInput> for Value {
    type Error = anyhow::Error;

    fn try_from(value: ValueInput) -> Result<Self, Self::Error> {
        Ok(match value.kind {
            ValueInputKind::Null => Value::Null,
            ValueInputKind::Text => Value::Text(require_field(value.text, "text")?),
            ValueInputKind::Number => Value::Number(require_field(value.number, "number")?),
            ValueInputKind::Boolean => Value::Boolean(require_field(value.boolean, "boolean")?),
            ValueInputKind::Bytes => Value::Bytes(require_field(value.bytes, "bytes")?),
            ValueInputKind::Reference => {
                Value::Reference(Uri::parse(require_field(value.reference, "reference")?)?)
            }
            ValueInputKind::Date => Value::Date(require_field(value.date, "date")?),
            ValueInputKind::DateTime => {
                Value::DateTime(require_field(value.date_time, "date_time")?)
            }
        })
    }
}

fn decode<T>(subject: &str, arguments: JsonValue) -> LlmResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(arguments).map_err(|error| LlmError::parse(subject, error))
}

fn build_query_entities_query(args: &QueryEntitiesArgs) -> anyhow::Result<String> {
    let mut clauses = vec![format!(
        r#"schema:type(Entity, {})"#,
        serde_json::to_string(&args.entity_type)?
    )];

    if let Some(filter) = &args.filter {
        for (index, clause) in parse_filter_clauses(filter)?.into_iter().enumerate() {
            let binding = format!("Value{index}");
            clauses.push(format!("{}(Entity, {binding})", clause.field));
            clauses.push(format!(
                r#"{binding} {} {}"#,
                clause.operator,
                serde_json::to_string(&clause.value)?
            ));
        }
    }

    clauses.push("schema:name(Entity, Name)".to_string());

    Ok(clauses.join(", "))
}

fn parse_filter_clauses(filter: &str) -> anyhow::Result<Vec<FilterClause>> {
    let normalized = filter.trim().trim_start_matches('{').trim_end_matches('}');
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    normalized
        .split("AND")
        .map(str::trim)
        .filter(|clause| !clause.is_empty())
        .map(parse_filter_clause)
        .collect()
}

fn parse_filter_clause(clause: &str) -> anyhow::Result<FilterClause> {
    for operator in [">=", "<=", ">", "<", "="] {
        if let Some((field, value)) = clause.split_once(operator) {
            let field = field.trim().to_string();
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();

            if field.is_empty() || value.is_empty() {
                anyhow::bail!("invalid filter clause `{clause}`");
            }

            return Ok(FilterClause {
                field,
                operator: operator.to_string(),
                value,
            });
        }
    }

    anyhow::bail!("unsupported filter clause `{clause}`")
}

fn entity_uris_from_substitutions(
    substitutions: &[datafox::Substitution],
    limit: usize,
) -> Vec<Uri> {
    let mut seen = HashSet::new();
    let mut entities = Vec::new();

    for substitution in substitutions {
        let Some(DatafoxValue::String(entity_uri)) = substitution.lookup("Entity") else {
            continue;
        };

        let Ok(uri) = Uri::parse(entity_uri.clone()) else {
            continue;
        };

        if seen.insert(uri.clone()) {
            entities.push(uri);
        }

        if entities.len() >= limit {
            break;
        }
    }

    entities
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FilterClause {
    field: String,
    operator: String,
    value: String,
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
    let schema = SchemaSettings::draft07()
        .with(|settings| {
            settings.meta_schema = None;
            settings.inline_subschemas = true;
        })
        .into_generator()
        .into_root_schema_for::<T>();
    let mut value = serde_json::to_value(schema).expect("json schema");
    sanitize_openai_schema(&mut value);
    value
}

fn require_field<T>(value: Option<T>, field: &str) -> anyhow::Result<T> {
    value.ok_or_else(|| anyhow::anyhow!("missing `{field}` for value input"))
}

fn sanitize_openai_schema(value: &mut JsonValue) {
    match value {
        JsonValue::Object(object) => {
            object.remove("$schema");
            object.remove("title");
            object.remove("examples");
            object.remove("default");
            object.remove("definitions");
            object.remove("$defs");

            if object.contains_key("properties") {
                object
                    .entry("type".to_string())
                    .or_insert_with(|| JsonValue::String("object".to_string()));
                object
                    .entry("additionalProperties".to_string())
                    .or_insert(JsonValue::Bool(false));
            }

            for child in object.values_mut() {
                sanitize_openai_schema(child);
            }
        }
        JsonValue::Array(values) => {
            for value in values {
                sanitize_openai_schema(value);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use agents::tools::TypedTool;
    use serde_json::Value as JsonValue;

    use super::{PoneglyphTool, ValueInput, ValueInputKind};

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
        assert_eq!(
            schema
                .pointer("/properties/facts/items/properties/value/type")
                .and_then(JsonValue::as_str),
            Some("object")
        );
        assert!(
            !contains_property_schema_without_type(&schema),
            "derived schemas with properties must declare a type or be a $ref"
        );
        assert!(
            !contains_ref(&schema),
            "state_facts schema must not use $ref because OpenAI tool validation is fragile around refs"
        );
        assert!(
            !schema
                .as_object()
                .is_some_and(|object| object.contains_key("$defs")),
            "sanitized tool schemas must not include $defs"
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

    fn contains_property_schema_without_type(value: &JsonValue) -> bool {
        match value {
            JsonValue::Object(object) => {
                let missing_type = object.contains_key("properties")
                    && !object.contains_key("type")
                    && !object.contains_key("$ref");
                missing_type || object.values().any(contains_property_schema_without_type)
            }
            JsonValue::Array(values) => values.iter().any(contains_property_schema_without_type),
            _ => false,
        }
    }

    fn contains_ref(value: &JsonValue) -> bool {
        match value {
            JsonValue::Object(object) => {
                object.contains_key("$ref") || object.values().any(contains_ref)
            }
            JsonValue::Array(values) => values.iter().any(contains_ref),
            _ => false,
        }
    }

    #[test]
    fn value_input_serializes_without_one_of_shape() {
        let value = ValueInput {
            kind: ValueInputKind::Text,
            text: Some("Dune".to_string()),
            number: None,
            boolean: None,
            bytes: None,
            reference: None,
            date: None,
            date_time: None,
        };

        let encoded = serde_json::to_value(value).expect("serialize value input");
        assert_eq!(encoded["type"], "text");
        assert_eq!(encoded["text"], "Dune");
    }
}
