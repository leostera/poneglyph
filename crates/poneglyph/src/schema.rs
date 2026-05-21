use std::collections::{BTreeMap, BTreeSet};

use crate::{Fact, FactService, Filter, PoneResult, Uri, Value, fact, uri};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const SCHEMA_KIND_NAMESPACE: &str = "schema:namespace";
pub const SCHEMA_KIND_KIND: &str = "schema:kind";
pub const SCHEMA_KIND_FIELD: &str = "schema:field";

pub const SCHEMA_TYPE: &str = "schema:type";
pub const SCHEMA_NAME: &str = "schema:name";
pub const SCHEMA_DOC: &str = "schema:doc";
pub const SCHEMA_SAME_AS: &str = "schema:sameAs";
pub const SCHEMA_FIELD_DOMAIN: &str = "schema:field:domain";
pub const SCHEMA_FIELD_RANGE: &str = "schema:field:range";
pub const SCHEMA_FIELD_VALUE_TYPE: &str = "schema:field:valueType";
pub const SCHEMA_FIELD_CARDINALITY: &str = "schema:field:cardinality";
pub const SCHEMA_FIELD_DEPRECATED: &str = "schema:field:deprecated";
pub const SCHEMA_FIELD_IDENTITY: &str = "schema:field:identity";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NamespaceSchema {
    #[schemars(with = "String")]
    pub uri: Uri,
    pub name: Option<String>,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct KindSchema {
    #[schemars(with = "String")]
    pub uri: Uri,
    pub name: Option<String>,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct FieldSchema {
    #[schemars(with = "String")]
    pub uri: Uri,
    pub name: Option<String>,
    pub doc: Option<String>,
    #[schemars(with = "Option<String>")]
    pub same_as: Option<Uri>,
    #[schemars(with = "Option<String>")]
    pub domain: Option<Uri>,
    #[schemars(with = "Option<String>")]
    pub range: Option<Uri>,
    pub value_type: Option<String>,
    pub cardinality: Option<String>,
    pub deprecated: Option<bool>,
    pub identity: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
pub struct BaseSchema {
    pub namespaces: Vec<NamespaceSchema>,
    pub kinds: Vec<KindSchema>,
    pub fields: Vec<FieldSchema>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
pub struct SchemaDefinition {
    pub base: BaseSchema,
    pub namespaces: Vec<NamespaceSchema>,
    pub kinds: Vec<KindSchema>,
    pub fields: Vec<FieldSchema>,
}

#[derive(Debug, Default, Clone)]
pub struct PartialSchemaEntry {
    pub schema_type: Option<Uri>,
    pub name: Option<String>,
    pub doc: Option<String>,
    pub same_as: Option<Uri>,
    pub domain: Option<Uri>,
    pub range: Option<Uri>,
    pub value_type: Option<String>,
    pub cardinality: Option<String>,
    pub deprecated: Option<bool>,
    pub identity: Option<bool>,
}

#[derive(Debug, Default, Clone)]
pub struct SchemaSnapshot {
    entries: BTreeMap<Uri, PartialSchemaEntry>,
    observed_namespaces: BTreeSet<Uri>,
    observed_kinds: BTreeSet<Uri>,
    observed_fields: BTreeSet<Uri>,
}

impl SchemaSnapshot {
    pub fn apply_fact(&mut self, fact: &Fact) {
        if fact.retraction {
            return;
        }

        match (fact.field.as_str(), &fact.value) {
            (SCHEMA_TYPE, Value::Reference(kind)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .schema_type = Some(kind.clone());
            }
            (SCHEMA_NAME, Value::Text(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().name = Some(value.clone());
            }
            (SCHEMA_DOC, Value::Text(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().doc = Some(value.clone());
            }
            (SCHEMA_SAME_AS, Value::Reference(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().same_as = Some(value.clone());
            }
            (SCHEMA_FIELD_DOMAIN, Value::Reference(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().domain = Some(value.clone());
            }
            (SCHEMA_FIELD_RANGE, Value::Reference(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().range = Some(value.clone());
            }
            (SCHEMA_FIELD_VALUE_TYPE, Value::Text(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .value_type = Some(value.clone());
            }
            (SCHEMA_FIELD_CARDINALITY, Value::Text(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .cardinality = Some(value.clone());
            }
            (SCHEMA_FIELD_DEPRECATED, Value::Boolean(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .deprecated = Some(*value);
            }
            (SCHEMA_FIELD_IDENTITY, Value::Boolean(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .identity = Some(*value);
            }
            _ => {}
        }

        if let Some(namespace_uri) = namespace_uri_for(&fact.entity) {
            self.observed_namespaces.insert(namespace_uri);
        }
        if let Some(namespace_uri) = namespace_uri_for(&fact.field) {
            self.observed_namespaces.insert(namespace_uri);
        }
        if let Value::Reference(reference) = &fact.value
            && let Some(namespace_uri) = namespace_uri_for(reference)
        {
            self.observed_namespaces.insert(namespace_uri);
        }

        self.observed_fields.insert(fact.field.clone());

        if let Some(kind_uri) = observed_kind_uri_for(&fact.entity) {
            self.observed_kinds.insert(kind_uri);
        }

        if fact.field.as_str() == SCHEMA_TYPE
            && let Value::Reference(kind_uri) = &fact.value
            && !is_base_schema_kind(kind_uri.as_str())
        {
            self.observed_kinds.insert(kind_uri.clone());
        }
    }

    pub fn observe_namespace(&mut self, uri: Uri) {
        self.observed_namespaces.insert(uri);
    }

    pub fn observe_kind(&mut self, uri: Uri) {
        self.observed_kinds.insert(uri);
    }

    pub fn observe_field(&mut self, uri: Uri) {
        self.observed_fields.insert(uri);
    }

    pub fn insert_entry(&mut self, uri: Uri, entry: PartialSchemaEntry) {
        self.entries.insert(uri, entry);
    }

    pub fn into_definition(self) -> SchemaDefinition {
        let mut namespaces = BTreeMap::<Uri, PartialSchemaEntry>::new();
        let mut kinds = BTreeMap::<Uri, PartialSchemaEntry>::new();
        let mut fields = BTreeMap::<Uri, PartialSchemaEntry>::new();

        for (uri, entry) in self.entries {
            match entry.schema_type.as_ref().map(|uri| uri.as_str()) {
                Some(SCHEMA_KIND_NAMESPACE) => {
                    namespaces.insert(uri, entry);
                }
                Some(SCHEMA_KIND_KIND) => {
                    kinds.insert(uri, entry);
                }
                Some(SCHEMA_KIND_FIELD) => {
                    fields.insert(uri, entry);
                }
                _ => {}
            }
        }

        for uri in self.observed_namespaces {
            if !kinds.contains_key(&uri) && !fields.contains_key(&uri) {
                namespaces.entry(uri).or_default();
            }
        }

        for uri in self.observed_kinds {
            if !namespaces.contains_key(&uri) && !fields.contains_key(&uri) {
                kinds.entry(uri).or_default();
            }
        }

        for uri in self.observed_fields {
            if !namespaces.contains_key(&uri) && !kinds.contains_key(&uri) {
                fields.entry(uri).or_default();
            }
        }

        let base = BaseSchema {
            namespaces: namespaces
                .iter()
                .filter(|(uri, _)| uri.as_str().starts_with("schema:"))
                .map(|(uri, entry)| NamespaceSchema {
                    uri: uri.clone(),
                    name: entry.name.clone(),
                    doc: entry.doc.clone(),
                })
                .collect(),
            kinds: kinds
                .iter()
                .filter(|(uri, _)| uri.as_str().starts_with("schema:"))
                .map(|(uri, entry)| KindSchema {
                    uri: uri.clone(),
                    name: entry.name.clone(),
                    doc: entry.doc.clone(),
                })
                .collect(),
            fields: fields
                .iter()
                .filter(|(uri, _)| uri.as_str().starts_with("schema:"))
                .map(|(uri, entry)| FieldSchema {
                    uri: uri.clone(),
                    name: entry.name.clone(),
                    doc: entry.doc.clone(),
                    same_as: entry.same_as.clone(),
                    domain: entry.domain.clone(),
                    range: entry.range.clone(),
                    value_type: entry.value_type.clone(),
                    cardinality: entry.cardinality.clone(),
                    deprecated: entry.deprecated,
                    identity: entry.identity,
                })
                .collect(),
        };

        SchemaDefinition {
            namespaces: namespaces
                .into_iter()
                .map(|(uri, entry)| NamespaceSchema {
                    uri,
                    name: entry.name,
                    doc: entry.doc,
                })
                .collect(),
            kinds: kinds
                .into_iter()
                .map(|(uri, entry)| KindSchema {
                    uri,
                    name: entry.name,
                    doc: entry.doc,
                })
                .collect(),
            fields: fields
                .into_iter()
                .map(|(uri, entry)| FieldSchema {
                    uri,
                    name: entry.name,
                    doc: entry.doc,
                    same_as: entry.same_as,
                    domain: entry.domain,
                    range: entry.range,
                    value_type: entry.value_type,
                    cardinality: entry.cardinality,
                    deprecated: entry.deprecated,
                    identity: entry.identity,
                })
                .collect(),
            base,
        }
    }
}

impl SchemaDefinition {
    pub fn from_facts<I>(facts: I) -> Self
    where
        I: IntoIterator<Item = Fact>,
    {
        let mut snapshot = SchemaSnapshot::default();
        for fact in facts {
            snapshot.apply_fact(&fact);
        }
        snapshot.into_definition()
    }
}

pub fn namespace_uri_for(uri: &Uri) -> Option<Uri> {
    Uri::parse(format!("{}:namespace", uri.namespace())).ok()
}

pub fn observed_kind_uri_for(uri: &Uri) -> Option<Uri> {
    let mut parts = uri.as_str().splitn(3, ':');
    let _namespace = parts.next()?;
    let _kind = parts.next()?;
    let _id = parts.next()?;
    Uri::parse(format!("{}:{}", uri.namespace(), uri.kind().ok()?)).ok()
}

fn is_base_schema_kind(uri: &str) -> bool {
    uri == SCHEMA_KIND_NAMESPACE || uri == SCHEMA_KIND_KIND || uri == SCHEMA_KIND_FIELD
}

#[cfg(test)]
pub async fn get_schema(fact_service: &FactService) -> PoneResult<SchemaDefinition> {
    fact_service.store().get_schema().await
}

pub fn base_schema_facts() -> Vec<Fact> {
    vec![
        fact!(
            uri!("schema:namespace"),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_KIND))
        ),
        fact!(
            uri!("schema:namespace"),
            uri!(SCHEMA_NAME),
            Value::text("Namespace")
        ),
        fact!(
            uri!("schema:namespace"),
            uri!(SCHEMA_DOC),
            Value::text("A namespace that groups related kinds and fields.")
        ),
        fact!(
            uri!("schema:kind"),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_KIND))
        ),
        fact!(uri!("schema:kind"), uri!(SCHEMA_NAME), Value::text("Kind")),
        fact!(
            uri!("schema:kind"),
            uri!(SCHEMA_DOC),
            Value::text("A kind of entity in the graph.")
        ),
        fact!(
            uri!("schema:field"),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_KIND))
        ),
        fact!(
            uri!("schema:field"),
            uri!(SCHEMA_NAME),
            Value::text("Field")
        ),
        fact!(
            uri!("schema:field"),
            uri!(SCHEMA_DOC),
            Value::text("A field or predicate in the graph.")
        ),
        fact!(
            uri!(SCHEMA_TYPE),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(uri!(SCHEMA_TYPE), uri!(SCHEMA_NAME), Value::text("Type")),
        fact!(
            uri!(SCHEMA_TYPE),
            uri!(SCHEMA_DOC),
            Value::text("The kind of a namespace, kind, field, or entity.")
        ),
        fact!(
            uri!(SCHEMA_NAME),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(uri!(SCHEMA_NAME), uri!(SCHEMA_NAME), Value::text("Name")),
        fact!(
            uri!(SCHEMA_NAME),
            uri!(SCHEMA_DOC),
            Value::text("A human readable name.")
        ),
        fact!(
            uri!(SCHEMA_DOC),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_DOC),
            uri!(SCHEMA_NAME),
            Value::text("Documentation")
        ),
        fact!(
            uri!(SCHEMA_DOC),
            uri!(SCHEMA_DOC),
            Value::text("Long-form documentation.")
        ),
        fact!(
            uri!(SCHEMA_SAME_AS),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_SAME_AS),
            uri!(SCHEMA_NAME),
            Value::text("Same As")
        ),
        fact!(
            uri!(SCHEMA_SAME_AS),
            uri!(SCHEMA_DOC),
            Value::text("Points to another schema entity that is equivalent.")
        ),
        fact!(
            uri!(SCHEMA_FIELD_DOMAIN),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_FIELD_DOMAIN),
            uri!(SCHEMA_NAME),
            Value::text("Field Domain")
        ),
        fact!(
            uri!(SCHEMA_FIELD_DOMAIN),
            uri!(SCHEMA_DOC),
            Value::text("The kind a field applies to.")
        ),
        fact!(
            uri!(SCHEMA_FIELD_RANGE),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_FIELD_RANGE),
            uri!(SCHEMA_NAME),
            Value::text("Field Range")
        ),
        fact!(
            uri!(SCHEMA_FIELD_RANGE),
            uri!(SCHEMA_DOC),
            Value::text("The range kind a field may point to.")
        ),
        fact!(
            uri!(SCHEMA_FIELD_VALUE_TYPE),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_FIELD_VALUE_TYPE),
            uri!(SCHEMA_NAME),
            Value::text("Field Value Type")
        ),
        fact!(
            uri!(SCHEMA_FIELD_VALUE_TYPE),
            uri!(SCHEMA_DOC),
            Value::text("The scalar value type a field accepts.")
        ),
        fact!(
            uri!(SCHEMA_FIELD_CARDINALITY),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_FIELD_CARDINALITY),
            uri!(SCHEMA_NAME),
            Value::text("Field Cardinality")
        ),
        fact!(
            uri!(SCHEMA_FIELD_CARDINALITY),
            uri!(SCHEMA_DOC),
            Value::text("Whether a field is one or many.")
        ),
        fact!(
            uri!(SCHEMA_FIELD_DEPRECATED),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_FIELD_DEPRECATED),
            uri!(SCHEMA_NAME),
            Value::text("Field Deprecated")
        ),
        fact!(
            uri!(SCHEMA_FIELD_DEPRECATED),
            uri!(SCHEMA_DOC),
            Value::text("Whether a field is deprecated.")
        ),
        fact!(
            uri!(SCHEMA_FIELD_IDENTITY),
            uri!(SCHEMA_TYPE),
            Value::reference(uri!(SCHEMA_KIND_FIELD))
        ),
        fact!(
            uri!(SCHEMA_FIELD_IDENTITY),
            uri!(SCHEMA_NAME),
            Value::text("Field Identity")
        ),
        fact!(
            uri!(SCHEMA_FIELD_IDENTITY),
            uri!(SCHEMA_DOC),
            Value::text("Whether a field participates in entity identity.")
        ),
    ]
}

pub async fn ensure_base_schema(fact_service: &FactService) -> PoneResult<()> {
    let mut existing = fact_service
        .get_facts(Filter::ByEntityUri(uri!(SCHEMA_KIND_NAMESPACE)))
        .await?;
    if existing.recv().await.is_some() {
        return Ok(());
    }

    fact_service.state_facts(base_schema_facts()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use crate::{FactService, InMemoryFactStore, PoneResult, fact};

    use super::*;

    #[test]
    fn schema_definition_assembles_namespaces_kinds_and_fields_from_facts() {
        let schema = SchemaDefinition::from_facts(vec![
            fact!(
                uri!("spotify:namespace"),
                uri!(SCHEMA_TYPE),
                Value::reference(uri!(SCHEMA_KIND_NAMESPACE))
            ),
            fact!(
                uri!("spotify:namespace"),
                uri!(SCHEMA_NAME),
                Value::text("Spotify")
            ),
            fact!(
                uri!("spotify:namespace"),
                uri!(SCHEMA_DOC),
                Value::text("Music schema.")
            ),
            fact!(
                uri!("spotify:artist"),
                uri!(SCHEMA_TYPE),
                Value::reference(uri!(SCHEMA_KIND_KIND))
            ),
            fact!(
                uri!("spotify:artist"),
                uri!(SCHEMA_NAME),
                Value::text("Artist")
            ),
            fact!(
                uri!("spotify:field:displayName"),
                uri!(SCHEMA_TYPE),
                Value::reference(uri!(SCHEMA_KIND_FIELD))
            ),
            fact!(
                uri!("spotify:field:displayName"),
                uri!(SCHEMA_NAME),
                Value::text("Display Name")
            ),
            fact!(
                uri!("spotify:field:displayName"),
                uri!(SCHEMA_FIELD_DOMAIN),
                Value::reference(uri!("spotify:artist"))
            ),
            fact!(
                uri!("spotify:field:displayName"),
                uri!(SCHEMA_FIELD_VALUE_TYPE),
                Value::text("text")
            ),
        ]);

        assert!(
            schema
                .namespaces
                .iter()
                .any(|namespace| namespace.uri.as_str() == "spotify:namespace")
        );
        assert!(
            schema
                .kinds
                .iter()
                .any(|kind| kind.uri.as_str() == "spotify:artist")
        );
        assert!(schema.fields.iter().any(|field| {
            field.uri.as_str() == "spotify:field:displayName"
                && field.value_type.as_deref() == Some("text")
        }));
    }

    #[test]
    fn schema_definition_infers_observed_schema_from_data_facts() {
        let schema = SchemaDefinition::from_facts(vec![fact!(
            uri!("agent:test:writer"),
            uri!("spotify:artist:rush"),
            uri!("spotify:displayName"),
            Value::text("Rush")
        )]);

        assert!(
            schema
                .namespaces
                .iter()
                .any(|namespace| namespace.uri.as_str() == "spotify:namespace")
        );
        assert!(
            schema
                .kinds
                .iter()
                .any(|kind| kind.uri.as_str() == "spotify:artist")
        );
        assert!(
            schema
                .fields
                .iter()
                .any(|field| field.uri.as_str() == "spotify:displayName")
        );
    }

    #[tokio::test]
    async fn ensure_base_schema_bootstraps_schema_facts_once() -> PoneResult<()> {
        let fact_service = FactService::builder()
            .with_store(InMemoryFactStore::new())
            .build()?;

        ensure_base_schema(&fact_service).await?;
        ensure_base_schema(&fact_service).await?;

        let schema = get_schema(&fact_service).await?;
        assert!(
            schema
                .base
                .kinds
                .iter()
                .any(|kind| kind.uri.as_str() == SCHEMA_KIND_FIELD)
        );
        assert!(
            schema
                .fields
                .iter()
                .any(|field| field.uri.as_str() == SCHEMA_TYPE)
        );

        Ok(())
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]

        #[test]
        fn property_repeating_schema_facts_does_not_duplicate_schema_entries_long(
            namespace_repeats in 1usize..8,
            kind_repeats in 1usize..8,
            field_repeats in 1usize..8,
        ) {
            let namespace_fact = fact!(
                uri!("spotify:namespace"),
                uri!(SCHEMA_TYPE),
                Value::reference(uri!(SCHEMA_KIND_NAMESPACE))
            );
            let kind_fact = fact!(
                uri!("spotify:artist"),
                uri!(SCHEMA_TYPE),
                Value::reference(uri!(SCHEMA_KIND_KIND))
            );
            let field_fact = fact!(
                uri!("spotify:field:displayName"),
                uri!(SCHEMA_TYPE),
                Value::reference(uri!(SCHEMA_KIND_FIELD))
            );

            let mut facts = Vec::new();
            facts.extend(std::iter::repeat_n(namespace_fact, namespace_repeats));
            facts.extend(std::iter::repeat_n(kind_fact, kind_repeats));
            facts.extend(std::iter::repeat_n(field_fact, field_repeats));

            let schema = SchemaDefinition::from_facts(facts);

            prop_assert_eq!(
                schema
                    .namespaces
                    .iter()
                    .filter(|namespace| namespace.uri.as_str() == "spotify:namespace")
                    .count(),
                1
            );
            prop_assert_eq!(
                schema
                    .kinds
                    .iter()
                    .filter(|kind| kind.uri.as_str() == "spotify:artist")
                    .count(),
                1
            );
            prop_assert_eq!(
                schema
                    .fields
                    .iter()
                    .filter(|field| field.uri.as_str() == "spotify:field:displayName")
                    .count(),
                1
            );
        }

        #[test]
        fn property_retracting_data_does_not_remove_schema_entries_long(
            values in prop::collection::vec(any::<Value>(), 1..8),
        ) {
            let schema_facts = vec![
                fact!(
                    uri!("spotify:namespace"),
                    uri!(SCHEMA_TYPE),
                    Value::reference(uri!(SCHEMA_KIND_NAMESPACE))
                ),
                fact!(
                    uri!("spotify:artist"),
                    uri!(SCHEMA_TYPE),
                    Value::reference(uri!(SCHEMA_KIND_KIND))
                ),
                fact!(
                    uri!("spotify:field:displayName"),
                    uri!(SCHEMA_TYPE),
                    Value::reference(uri!(SCHEMA_KIND_FIELD))
                ),
            ];

            let mut expected_facts = schema_facts.clone();
            let mut facts = schema_facts;

            for (index, value) in values.into_iter().enumerate() {
                let entity_id = index.to_string();
                let entity = Uri::from_parts("local", "entity", Some(&entity_id))
                    .expect("entity");
                let assertion = fact!(
                    uri!("agent:prop:data"),
                    entity,
                    uri!("local:field:data"),
                    value
                );
                let mut retraction = assertion.clone();
                retraction.retraction = true;
                expected_facts.push(assertion.clone());
                facts.push(assertion);
                facts.push(retraction);
            }

            let expected = SchemaDefinition::from_facts(expected_facts);
            let schema = SchemaDefinition::from_facts(facts);
            prop_assert_eq!(schema, expected);
        }
    }
}
