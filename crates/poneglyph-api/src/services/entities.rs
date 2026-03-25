use crate::context::AppContext;
use poneglyph::Uri;

#[derive(Debug, Clone)]
pub(crate) struct EntitySummary {
    pub uri: String,
    pub namespace: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub(crate) struct EntityField {
    pub field: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub(crate) struct EntityDetail {
    pub uri: String,
    pub namespace: String,
    pub kind: String,
    pub fields: Vec<EntityField>,
}

pub(crate) struct EntityService<'a> {
    context: &'a AppContext,
}

#[derive(Debug, Clone)]
pub(crate) struct SchemaDefinition {
    pub namespaces: Vec<SchemaNamespace>,
    pub kinds: Vec<SchemaKind>,
    pub fields: Vec<SchemaField>,
}

#[derive(Debug, Clone)]
pub(crate) struct SchemaNamespace {
    pub uri: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SchemaKind {
    pub uri: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SchemaField {
    pub uri: String,
    pub name: Option<String>,
    pub domain: Option<String>,
    pub range: Option<String>,
}

impl<'a> EntityService<'a> {
    pub(crate) fn new(context: &'a AppContext) -> Self {
        Self { context }
    }

    pub(crate) async fn list_entities(
        &self,
        limit: usize,
        offset: usize,
    ) -> std::result::Result<Vec<EntitySummary>, String> {
        self.context
            .poneglyph
            .list_entities(limit, offset)
            .await
            .map(|entities| {
                entities
                    .into_iter()
                    .map(|entity| EntitySummary {
                        uri: entity.uri.to_string(),
                        namespace: entity.namespace,
                        kind: entity.kind,
                    })
                    .collect()
            })
            .map_err(|error| format!("failed to list entities: {error}"))
    }

    pub(crate) async fn schema_definition(&self) -> std::result::Result<SchemaDefinition, String> {
        self.context
            .poneglyph
            .get_schema()
            .await
            .map(|schema| SchemaDefinition {
                namespaces: schema
                    .namespaces
                    .into_iter()
                    .map(|namespace| SchemaNamespace {
                        uri: namespace.uri.to_string(),
                        name: namespace.name,
                    })
                    .collect(),
                kinds: schema
                    .kinds
                    .into_iter()
                    .map(|kind| SchemaKind {
                        uri: kind.uri.to_string(),
                        name: kind.name,
                    })
                    .collect(),
                fields: schema
                    .fields
                    .into_iter()
                    .map(|field| SchemaField {
                        uri: field.uri.to_string(),
                        name: field.name,
                        domain: field.domain.map(|value| value.to_string()),
                        range: field.range.map(|value| value.to_string()),
                    })
                    .collect(),
            })
            .map_err(|error| format!("failed to fetch schema definition: {error}"))
    }

    pub(crate) async fn entity_kinds(&self) -> std::result::Result<Vec<String>, String> {
        self.schema_definition().await.map(|schema| {
            let mut kinds = schema
                .kinds
                .into_iter()
                .filter_map(|kind| kind.uri.split(':').nth(1).map(str::to_string))
                .filter(|kind| !kind.is_empty())
                .collect::<Vec<_>>();
            kinds.sort();
            kinds.dedup();
            kinds
        })
    }

    pub(crate) async fn entity_by_uri(
        &self,
        entity_uri: &str,
    ) -> std::result::Result<Option<EntityDetail>, String> {
        let uri = Uri::parse(entity_uri)
            .map_err(|error| format!("invalid entity uri '{entity_uri}': {error}"))?;

        let entity = self
            .context
            .poneglyph
            .get_entity(&uri)
            .await
            .map_err(|error| format!("failed to fetch entity: {error}"))?;

        Ok(entity.map(|entity| {
            let mut fields = entity
                .fields
                .into_iter()
                .map(|(field_uri, value)| EntityField {
                    field: field_uri.to_string(),
                    value: value_to_string(&value),
                })
                .collect::<Vec<_>>();
            fields.sort_by(|left, right| left.field.cmp(&right.field));

            EntityDetail {
                uri: entity.uri.to_string(),
                namespace: entity.namespace,
                kind: entity.kind,
                fields,
            }
        }))
    }
}

fn value_to_string(value: &poneglyph::Value) -> String {
    match value {
        poneglyph::Value::Null => "null".to_string(),
        poneglyph::Value::Text(text) => text.clone(),
        poneglyph::Value::Number(number) => number.clone(),
        poneglyph::Value::Boolean(boolean) => boolean.to_string(),
        poneglyph::Value::Bytes(bytes) => format!("<{} bytes>", bytes.len()),
        poneglyph::Value::Reference(uri) => uri.to_string(),
        poneglyph::Value::Date(date) => date.to_string(),
        poneglyph::Value::DateTime(date_time) => date_time.to_rfc3339(),
        poneglyph::Value::List(list) => {
            serde_json::to_string(list).unwrap_or_else(|_| "<list>".to_string())
        }
        poneglyph::Value::Map(map) => {
            serde_json::to_string(map).unwrap_or_else(|_| "<map>".to_string())
        }
    }
}
