// Tonic service methods conventionally return `Result<_, tonic::Status>`;
// boxing every gRPC error would make the service boundary less idiomatic.
#![allow(clippy::result_large_err)]

pub mod proto {
    tonic::include_proto!("poneglyph.daemon.v1");
}

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, NaiveDate, Utc};
use poneglyph_core::{
    ActiveFact, ActiveFilter, BaseSchema, Entity, Fact, FieldSchema, Filter, KindSchema,
    NamespaceSchema, PoneResult, Poneglyph, Query, QueryResult, SchemaDefinition, SearchHit, Uri,
    Value,
};
use serde::Serialize;
use tonic::{Request, Response, Status};

use self::proto::poneglyph_daemon_server::PoneglyphDaemon;
use self::proto::{
    GetEntityRequest, GetEntityResponse, GetSchemaRequest, JsonResponse, ListEntitiesRequest,
    ListEntitiesResponse, ListFactsRequest, ListFactsResponse, QueryRequest, QueryResponse,
    QueryRow, RetractFactByIdRequest, SchemaEntries, SearchEntitiesRequest, SearchEntitiesResponse,
    ShutdownRequest, ShutdownResponse, StateFactRequest, StateFactResponse, StateFactTypedRequest,
    StateFactsRequest, StateFactsTypedRequest, StatusRequest, StatusResponse,
};

pub struct DaemonApi {
    poneglyph: Arc<Poneglyph>,
    started_at: Instant,
    shutdown: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}

impl DaemonApi {
    pub fn new(poneglyph: Arc<Poneglyph>, shutdown: tokio::sync::oneshot::Sender<()>) -> Self {
        Self {
            poneglyph,
            started_at: Instant::now(),
            shutdown: Arc::new(Mutex::new(Some(shutdown))),
        }
    }

    async fn state_fact_batch(&self, facts: Vec<Fact>) -> Result<StateFactResponse, Status> {
        if facts.is_empty() {
            return Err(Status::invalid_argument("empty fact batch"));
        }

        let fact_ids = facts
            .iter()
            .map(|fact| fact.fact_id.to_string())
            .collect::<Vec<_>>();
        let tx_id = self.poneglyph.state_facts(facts).await.map_err(internal)?;

        Ok(StateFactResponse {
            tx_id: tx_id.to_string(),
            fact_id: fact_ids.first().cloned().unwrap_or_default(),
            fact_ids,
        })
    }

    async fn query_result(&self, request: QueryRequest) -> Result<QueryResult, Status> {
        let query = Query::parse(&request.expression).map_err(invalid_argument)?;
        self.poneglyph.query(query).await.map_err(internal)
    }

    async fn get_entity_item(&self, request: GetEntityRequest) -> Result<Option<Entity>, Status> {
        let uri = parse_uri(request.uri)?;
        self.poneglyph.get_entity(&uri).await.map_err(internal)
    }

    async fn schema_definition(&self) -> Result<SchemaDefinition, Status> {
        self.poneglyph.get_schema().await.map_err(internal)
    }

    async fn list_entity_items(&self, request: ListEntitiesRequest) -> Result<Vec<Entity>, Status> {
        let pagination = Pagination::try_from_limit_offset(request.limit, request.offset)?;
        self.poneglyph
            .list_entities(pagination.limit, pagination.offset)
            .await
            .map_err(internal)
    }

    fn search_entity_items(
        &self,
        request: SearchEntitiesRequest,
    ) -> Result<Vec<SearchHit>, Status> {
        let pagination = Pagination::try_from_limit_offset(request.limit, 0)?;
        self.poneglyph
            .search(&request.query, pagination.limit)
            .map_err(internal)
    }

    async fn list_fact_items(&self, request: ListFactsRequest) -> Result<FactListItems, Status> {
        let pagination = Pagination::try_from_limit_offset(request.limit, request.offset)?;

        match fact_list_filter(&request)? {
            FactListFilter::Active(filter) => {
                let facts = self
                    .poneglyph
                    .fact_service()
                    .store()
                    .get_active_facts(filter)
                    .await
                    .map_err(internal)?;
                Ok(FactListItems::Active(
                    pagination.apply(collect_results(facts).await?),
                ))
            }
            FactListFilter::Log(filter) => {
                let facts = self
                    .poneglyph
                    .fact_service()
                    .get_facts(filter)
                    .await
                    .map_err(internal)?;
                Ok(FactListItems::Log(
                    pagination.apply(collect_results(facts).await?),
                ))
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Pagination {
    limit: usize,
    offset: usize,
}

impl Pagination {
    fn try_from_limit_offset(limit: u64, offset: u64) -> Result<Self, Status> {
        if limit == 0 {
            return Err(Status::invalid_argument("limit must be greater than 0"));
        }
        Ok(Self {
            limit: usize::try_from(limit)
                .map_err(|_| Status::invalid_argument("limit is too large"))?,
            offset: usize::try_from(offset)
                .map_err(|_| Status::invalid_argument("offset is too large"))?,
        })
    }

    fn apply<T>(self, items: Vec<T>) -> Vec<T> {
        items
            .into_iter()
            .skip(self.offset)
            .take(self.limit)
            .collect()
    }
}

fn invalid_argument(error: impl ToString) -> Status {
    Status::invalid_argument(error.to_string())
}

fn internal(error: impl ToString) -> Status {
    Status::internal(error.to_string())
}

fn parse_uri(value: impl Into<String>) -> Result<Uri, Status> {
    Uri::parse(value).map_err(invalid_argument)
}

fn json_response<T>(value: &T) -> Result<Response<JsonResponse>, Status>
where
    T: Serialize + ?Sized,
{
    let json = serde_json::to_string_pretty(value).map_err(internal)?;
    Ok(Response::new(JsonResponse { json }))
}

async fn collect_results<T>(
    mut stream: tokio::sync::mpsc::Receiver<PoneResult<T>>,
) -> Result<Vec<T>, Status> {
    let mut items = Vec::new();
    while let Some(item) = stream.recv().await {
        items.push(item.map_err(internal)?);
    }
    Ok(items)
}

enum FactListItems {
    Active(Vec<ActiveFact>),
    Log(Vec<Fact>),
}

pub fn fact_to_proto(fact: &Fact) -> proto::Fact {
    proto::Fact {
        fact_id: fact.fact_id.to_string(),
        source: fact.source.to_string(),
        entity: fact.entity.to_string(),
        field: fact.field.to_string(),
        value: Some(value_to_proto(&fact.value)),
        retraction: fact.retraction,
        stated_at: fact.stated_at.to_rfc3339(),
        tx_id: fact
            .tx_id
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
    }
}

pub fn active_fact_to_proto(fact: &ActiveFact) -> proto::ActiveFact {
    proto::ActiveFact {
        fact_id: fact.fact_id.to_string(),
        tx_id: fact.tx_id.to_string(),
        source: fact.source.to_string(),
        entity: fact.entity.to_string(),
        field: fact.field.to_string(),
        value: Some(value_to_proto(&fact.value)),
    }
}

pub fn active_fact_from_proto(fact: proto::ActiveFact) -> Result<ActiveFact, String> {
    Ok(ActiveFact {
        fact_id: parse_core_uri(fact.fact_id)?,
        tx_id: parse_core_uri(fact.tx_id)?,
        source: parse_core_uri(fact.source)?,
        entity: parse_core_uri(fact.entity)?,
        field: parse_core_uri(fact.field)?,
        value: value_from_proto(fact.value.ok_or("missing active fact value")?)?,
    })
}

pub fn fact_from_proto(fact: proto::Fact) -> Result<Fact, String> {
    Ok(Fact {
        fact_id: parse_core_uri(fact.fact_id)?,
        source: parse_core_uri(fact.source)?,
        entity: parse_core_uri(fact.entity)?,
        field: parse_core_uri(fact.field)?,
        value: value_from_proto(fact.value.ok_or("missing fact value")?)?,
        retraction: fact.retraction,
        stated_at: DateTime::parse_from_rfc3339(&fact.stated_at)
            .map_err(|error| error.to_string())?
            .with_timezone(&Utc),
        tx_id: if fact.tx_id.is_empty() {
            None
        } else {
            Some(parse_core_uri(fact.tx_id)?)
        },
    })
}

pub fn value_to_proto(value: &Value) -> proto::Value {
    use proto::value::Kind;

    let kind = match value {
        Value::Null => Kind::NullValue(proto::NullValue {}),
        Value::Text(value) => Kind::Text(value.clone()),
        Value::Number(value) => Kind::Number(value.clone()),
        Value::Boolean(value) => Kind::Boolean(*value),
        Value::Bytes(value) => Kind::Bytes(value.clone()),
        Value::Reference(uri) => Kind::ReferenceUri(uri.to_string()),
        Value::Date(value) => Kind::Date(value.to_string()),
        Value::DateTime(value) => Kind::Datetime(value.to_rfc3339()),
        Value::List(values) => Kind::List(proto::ValueList {
            values: values.iter().map(value_to_proto).collect(),
        }),
        Value::Map(values) => Kind::Map(proto::ValueMap {
            values: values
                .iter()
                .map(|(key, value)| (key.clone(), value_to_proto(value)))
                .collect(),
        }),
    };

    proto::Value { kind: Some(kind) }
}

pub fn value_from_proto(value: proto::Value) -> Result<Value, String> {
    use proto::value::Kind;

    match value.kind.ok_or("missing value kind")? {
        Kind::NullValue(_) => Ok(Value::Null),
        Kind::Text(value) => Ok(Value::Text(value)),
        Kind::Number(value) => Ok(Value::Number(value)),
        Kind::Boolean(value) => Ok(Value::Boolean(value)),
        Kind::Bytes(value) => Ok(Value::Bytes(value)),
        Kind::ReferenceUri(value) => Ok(Value::Reference(parse_core_uri(value)?)),
        Kind::Date(value) => Ok(Value::Date(
            NaiveDate::parse_from_str(&value, "%Y-%m-%d").map_err(|error| error.to_string())?,
        )),
        Kind::Datetime(value) => Ok(Value::DateTime(
            DateTime::parse_from_rfc3339(&value)
                .map_err(|error| error.to_string())?
                .with_timezone(&Utc),
        )),
        Kind::List(value) => Ok(Value::List(
            value
                .values
                .into_iter()
                .map(value_from_proto)
                .collect::<Result<_, _>>()?,
        )),
        Kind::Map(value) => Ok(Value::Map(
            value
                .values
                .into_iter()
                .map(|(key, value)| value_from_proto(value).map(|value| (key, value)))
                .collect::<Result<BTreeMap<_, _>, _>>()?,
        )),
    }
}

pub fn entity_to_proto(entity: &Entity) -> proto::Entity {
    proto::Entity {
        uri: entity.uri.to_string(),
        namespace: entity.namespace.clone(),
        kind: entity.kind.clone(),
        fields: entity
            .fields
            .iter()
            .map(|(field, value)| (field.to_string(), value_to_proto(value)))
            .collect(),
    }
}

pub fn entity_from_proto(entity: proto::Entity) -> Result<Entity, String> {
    Ok(Entity {
        uri: parse_core_uri(entity.uri)?,
        namespace: entity.namespace,
        kind: entity.kind,
        fields: entity
            .fields
            .into_iter()
            .map(|(field, value)| Ok((parse_core_uri(field)?, value_from_proto(value)?)))
            .collect::<Result<BTreeMap<_, _>, String>>()?,
    })
}

pub fn search_hit_to_proto(hit: &SearchHit) -> proto::SearchHit {
    proto::SearchHit {
        entity_uri: hit.entity_uri.to_string(),
        score: hit.score,
    }
}

pub fn search_hit_from_proto(hit: proto::SearchHit) -> Result<SearchHit, String> {
    Ok(SearchHit {
        entity_uri: parse_core_uri(hit.entity_uri)?,
        score: hit.score,
    })
}

pub fn schema_to_proto(schema: &SchemaDefinition) -> proto::SchemaDefinition {
    proto::SchemaDefinition {
        base: Some(schema_entries_to_proto(
            &schema.base.namespaces,
            &schema.base.kinds,
            &schema.base.fields,
        )),
        namespaces: schema
            .namespaces
            .iter()
            .map(namespace_schema_to_proto)
            .collect(),
        kinds: schema.kinds.iter().map(kind_schema_to_proto).collect(),
        fields: schema.fields.iter().map(field_schema_to_proto).collect(),
    }
}

pub fn schema_from_proto(schema: proto::SchemaDefinition) -> Result<SchemaDefinition, String> {
    let base = schema.base.unwrap_or_default();
    Ok(SchemaDefinition {
        base: BaseSchema {
            namespaces: base
                .namespaces
                .into_iter()
                .map(namespace_schema_from_proto)
                .collect::<Result<_, _>>()?,
            kinds: base
                .kinds
                .into_iter()
                .map(kind_schema_from_proto)
                .collect::<Result<_, _>>()?,
            fields: base
                .fields
                .into_iter()
                .map(field_schema_from_proto)
                .collect::<Result<_, _>>()?,
        },
        namespaces: schema
            .namespaces
            .into_iter()
            .map(namespace_schema_from_proto)
            .collect::<Result<_, _>>()?,
        kinds: schema
            .kinds
            .into_iter()
            .map(kind_schema_from_proto)
            .collect::<Result<_, _>>()?,
        fields: schema
            .fields
            .into_iter()
            .map(field_schema_from_proto)
            .collect::<Result<_, _>>()?,
    })
}

fn schema_entries_to_proto(
    namespaces: &[NamespaceSchema],
    kinds: &[KindSchema],
    fields: &[FieldSchema],
) -> SchemaEntries {
    SchemaEntries {
        namespaces: namespaces.iter().map(namespace_schema_to_proto).collect(),
        kinds: kinds.iter().map(kind_schema_to_proto).collect(),
        fields: fields.iter().map(field_schema_to_proto).collect(),
    }
}

fn namespace_schema_to_proto(schema: &NamespaceSchema) -> proto::NamespaceSchema {
    proto::NamespaceSchema {
        uri: schema.uri.to_string(),
        name: schema.name.clone(),
        doc: schema.doc.clone(),
    }
}

fn namespace_schema_from_proto(schema: proto::NamespaceSchema) -> Result<NamespaceSchema, String> {
    Ok(NamespaceSchema {
        uri: parse_core_uri(schema.uri)?,
        name: schema.name,
        doc: schema.doc,
    })
}

fn kind_schema_to_proto(schema: &KindSchema) -> proto::KindSchema {
    proto::KindSchema {
        uri: schema.uri.to_string(),
        name: schema.name.clone(),
        doc: schema.doc.clone(),
    }
}

fn kind_schema_from_proto(schema: proto::KindSchema) -> Result<KindSchema, String> {
    Ok(KindSchema {
        uri: parse_core_uri(schema.uri)?,
        name: schema.name,
        doc: schema.doc,
    })
}

fn field_schema_to_proto(schema: &FieldSchema) -> proto::FieldSchema {
    proto::FieldSchema {
        uri: schema.uri.to_string(),
        name: schema.name.clone(),
        doc: schema.doc.clone(),
        same_as: schema.same_as.as_ref().map(ToString::to_string),
        domain: schema.domain.as_ref().map(ToString::to_string),
        range: schema.range.as_ref().map(ToString::to_string),
        value_type: schema.value_type.clone(),
        cardinality: schema.cardinality.clone(),
        deprecated: schema.deprecated,
        identity: schema.identity,
    }
}

fn field_schema_from_proto(schema: proto::FieldSchema) -> Result<FieldSchema, String> {
    Ok(FieldSchema {
        uri: parse_core_uri(schema.uri)?,
        name: schema.name,
        doc: schema.doc,
        same_as: schema.same_as.map(parse_core_uri).transpose()?,
        domain: schema.domain.map(parse_core_uri).transpose()?,
        range: schema.range.map(parse_core_uri).transpose()?,
        value_type: schema.value_type,
        cardinality: schema.cardinality,
        deprecated: schema.deprecated,
        identity: schema.identity,
    })
}

pub fn query_response_to_proto(substitutions: &[datafox::Substitution]) -> QueryResponse {
    QueryResponse {
        rows: substitutions.iter().map(query_row_to_proto).collect(),
    }
}

fn query_row_to_proto(substitution: &datafox::Substitution) -> QueryRow {
    QueryRow {
        bindings: substitution
            .bindings()
            .map(|(variable, value)| proto::QueryBinding {
                variable: variable.to_string(),
                value: Some(query_value_to_proto(value)),
            })
            .collect(),
    }
}

fn query_value_to_proto(value: &datafox::Value) -> proto::QueryValue {
    use proto::query_value::Kind;

    let kind = match value {
        datafox::Value::Integer(value) => Kind::Integer(*value),
        datafox::Value::String(value) => Kind::String(value.clone()),
    };
    proto::QueryValue { kind: Some(kind) }
}

fn list_facts_response(items: &FactListItems) -> ListFactsResponse {
    match items {
        FactListItems::Active(facts) => ListFactsResponse {
            active: true,
            facts: Vec::new(),
            active_facts: facts.iter().map(active_fact_to_proto).collect(),
        },
        FactListItems::Log(facts) => ListFactsResponse {
            active: false,
            facts: facts.iter().map(fact_to_proto).collect(),
            active_facts: Vec::new(),
        },
    }
}

fn parse_core_uri(value: String) -> Result<Uri, String> {
    Uri::parse(value).map_err(|error| error.to_string())
}

enum FactListFilter {
    Active(ActiveFilter),
    Log(Filter),
}

fn fact_list_filter(request: &ListFactsRequest) -> Result<FactListFilter, Status> {
    if request.active {
        if !request.tx_id.is_empty() {
            return Err(Status::invalid_argument(
                "active fact listing does not support tx_id filtering",
            ));
        }

        let filter = if request.entity_uri.is_empty() {
            ActiveFilter::All
        } else {
            ActiveFilter::ByEntity(parse_uri(request.entity_uri.clone())?)
        };
        return Ok(FactListFilter::Active(filter));
    }

    let filter = match (request.entity_uri.as_str(), request.tx_id.as_str()) {
        ("", "") => Filter::All,
        (entity_uri, "") => Filter::ByEntityUri(parse_uri(entity_uri.to_owned())?),
        ("", tx_id) => Filter::ByTx(parse_uri(tx_id.to_owned())?),
        _ => {
            return Err(Status::invalid_argument(
                "list facts accepts only one filter: entity_uri or tx_id",
            ));
        }
    };
    Ok(FactListFilter::Log(filter))
}

#[tonic::async_trait]
impl PoneglyphDaemon for DaemonApi {
    async fn status(
        &self,
        _request: Request<StatusRequest>,
    ) -> Result<Response<StatusResponse>, Status> {
        Ok(Response::new(StatusResponse {
            status: "running".to_string(),
            workspace: self.poneglyph.workspace().root().display().to_string(),
            uptime_seconds: self.started_at.elapsed().as_secs(),
        }))
    }

    async fn shutdown(
        &self,
        _request: Request<ShutdownRequest>,
    ) -> Result<Response<ShutdownResponse>, Status> {
        let sender = self
            .shutdown
            .lock()
            .map_err(|_| Status::internal("shutdown lock poisoned"))?
            .take();

        match sender {
            Some(sender) => {
                let _ = sender.send(());
                Ok(Response::new(ShutdownResponse {
                    status: "stopping".to_string(),
                }))
            }
            None => Ok(Response::new(ShutdownResponse {
                status: "already_stopping".to_string(),
            })),
        }
    }

    async fn state_fact(
        &self,
        request: Request<StateFactRequest>,
    ) -> Result<Response<StateFactResponse>, Status> {
        let fact = serde_json::from_str::<Fact>(&request.into_inner().fact_json)
            .map_err(invalid_argument)?;
        Ok(Response::new(self.state_fact_batch(vec![fact]).await?))
    }

    async fn state_fact_typed(
        &self,
        request: Request<StateFactTypedRequest>,
    ) -> Result<Response<StateFactResponse>, Status> {
        let fact = request
            .into_inner()
            .fact
            .ok_or_else(|| Status::invalid_argument("missing fact"))
            .and_then(|fact| fact_from_proto(fact).map_err(invalid_argument))?;
        Ok(Response::new(self.state_fact_batch(vec![fact]).await?))
    }

    async fn state_facts(
        &self,
        request: Request<StateFactsRequest>,
    ) -> Result<Response<StateFactResponse>, Status> {
        let facts = request
            .into_inner()
            .fact_json
            .into_iter()
            .map(|json| serde_json::from_str::<Fact>(&json).map_err(invalid_argument))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Response::new(self.state_fact_batch(facts).await?))
    }

    async fn state_facts_typed(
        &self,
        request: Request<StateFactsTypedRequest>,
    ) -> Result<Response<StateFactResponse>, Status> {
        let facts = request
            .into_inner()
            .facts
            .into_iter()
            .map(|fact| fact_from_proto(fact).map_err(invalid_argument))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Response::new(self.state_fact_batch(facts).await?))
    }

    async fn retract_fact_by_id(
        &self,
        request: Request<RetractFactByIdRequest>,
    ) -> Result<Response<StateFactResponse>, Status> {
        let fact_id = parse_uri(request.into_inner().fact_id)?;
        let mut facts = self
            .poneglyph
            .fact_service()
            .get_facts(Filter::ById(fact_id.clone()))
            .await
            .map_err(internal)?;
        let fact = facts
            .recv()
            .await
            .ok_or_else(|| Status::not_found(format!("fact `{fact_id}` not found")))?
            .map_err(internal)?;
        let retraction = Fact::builder()
            .source(fact.source)
            .entity(fact.entity)
            .field(fact.field)
            .value(fact.value)
            .retract()
            .build()
            .map_err(internal)?;
        let fact_id = retraction.fact_id.to_string();
        let tx_id = self
            .poneglyph
            .state_facts(vec![retraction])
            .await
            .map_err(internal)?;

        Ok(Response::new(StateFactResponse {
            tx_id: tx_id.to_string(),
            fact_id: fact_id.clone(),
            fact_ids: vec![fact_id],
        }))
    }

    async fn list_facts(
        &self,
        request: Request<ListFactsRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        match self.list_fact_items(request.into_inner()).await? {
            FactListItems::Active(facts) => json_response(&facts),
            FactListItems::Log(facts) => json_response(&facts),
        }
    }

    async fn list_facts_typed(
        &self,
        request: Request<ListFactsRequest>,
    ) -> Result<Response<ListFactsResponse>, Status> {
        let items = self.list_fact_items(request.into_inner()).await?;
        Ok(Response::new(list_facts_response(&items)))
    }

    async fn query(
        &self,
        request: Request<QueryRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let result = self.query_result(request.into_inner()).await?;
        json_response(result.substitutions())
    }

    async fn query_typed(
        &self,
        request: Request<QueryRequest>,
    ) -> Result<Response<QueryResponse>, Status> {
        let result = self.query_result(request.into_inner()).await?;
        Ok(Response::new(query_response_to_proto(
            result.substitutions(),
        )))
    }

    async fn get_entity(
        &self,
        request: Request<GetEntityRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let entity = self.get_entity_item(request.into_inner()).await?;
        json_response(&entity)
    }

    async fn get_entity_typed(
        &self,
        request: Request<GetEntityRequest>,
    ) -> Result<Response<GetEntityResponse>, Status> {
        let entity = self.get_entity_item(request.into_inner()).await?;
        Ok(Response::new(GetEntityResponse {
            entity: entity.as_ref().map(entity_to_proto),
        }))
    }

    async fn list_entities(
        &self,
        request: Request<ListEntitiesRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let entities = self.list_entity_items(request.into_inner()).await?;
        json_response(&entities)
    }

    async fn list_entities_typed(
        &self,
        request: Request<ListEntitiesRequest>,
    ) -> Result<Response<ListEntitiesResponse>, Status> {
        let entities = self.list_entity_items(request.into_inner()).await?;
        Ok(Response::new(ListEntitiesResponse {
            entities: entities.iter().map(entity_to_proto).collect(),
        }))
    }

    async fn search_entities(
        &self,
        request: Request<SearchEntitiesRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let hits = self.search_entity_items(request.into_inner())?;
        json_response(&hits)
    }

    async fn search_entities_typed(
        &self,
        request: Request<SearchEntitiesRequest>,
    ) -> Result<Response<SearchEntitiesResponse>, Status> {
        let hits = self.search_entity_items(request.into_inner())?;
        Ok(Response::new(SearchEntitiesResponse {
            hits: hits.iter().map(search_hit_to_proto).collect(),
        }))
    }

    async fn get_schema(
        &self,
        _request: Request<GetSchemaRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let schema = self.schema_definition().await?;
        json_response(&schema)
    }

    async fn get_schema_typed(
        &self,
        _request: Request<GetSchemaRequest>,
    ) -> Result<Response<proto::SchemaDefinition>, Status> {
        let schema = self.schema_definition().await?;
        Ok(Response::new(schema_to_proto(&schema)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use std::collections::BTreeMap;

    use chrono::{NaiveDate, TimeZone, Utc};
    use poneglyph_core::{
        ActiveFact, BaseSchema, Entity, Fact, FieldSchema, InMemoryEntityStore, InMemoryFactStore,
        NamespaceSchema, Poneglyph, Projection, ProjectionBatch, SchemaDefinition, SearchHit,
        SearchProjection, Value, fact, uri,
    };
    use tonic::{Code, Request};

    use super::proto::poneglyph_daemon_server::PoneglyphDaemon;
    use super::proto::{
        GetEntityRequest, GetSchemaRequest, ListEntitiesRequest, ListFactsRequest, QueryRequest,
        SearchEntitiesRequest, StateFactRequest, StateFactTypedRequest, StateFactsRequest,
        StateFactsTypedRequest,
    };
    use super::{
        DaemonApi, active_fact_from_proto, active_fact_to_proto, entity_from_proto,
        entity_to_proto, fact_from_proto, fact_to_proto, query_response_to_proto,
        schema_from_proto, schema_to_proto, search_hit_from_proto, search_hit_to_proto,
        value_from_proto, value_to_proto,
    };

    async fn api() -> DaemonApi {
        api_with_runtime().await.0
    }

    async fn api_with_runtime() -> (DaemonApi, Arc<Poneglyph>) {
        let runtime = Arc::new(
            Poneglyph::builder()
                .with_fact_service(
                    poneglyph_core::FactService::builder()
                        .with_store(InMemoryFactStore::new())
                        .build()
                        .expect("fact service"),
                )
                .with_entity_store(InMemoryEntityStore::new())
                .with_search_projection(SearchProjection::create_in_memory().expect("search"))
                .build()
                .await
                .expect("runtime"),
        );
        let (shutdown, _receiver) = tokio::sync::oneshot::channel();
        (DaemonApi::new(runtime.clone(), shutdown), runtime)
    }

    #[test]
    fn typed_value_proto_round_trips_nested_values() {
        let mut values = BTreeMap::new();
        values.insert("title".to_string(), Value::text("Signals"));
        values.insert(
            "released".to_string(),
            Value::date(NaiveDate::from_ymd_opt(1982, 9, 9).expect("date")),
        );
        values.insert(
            "refs".to_string(),
            Value::list(vec![Value::reference(uri!("spotify:artist:rush"))]),
        );
        let value = Value::map(values);

        let round_tripped = value_from_proto(value_to_proto(&value)).expect("value round-trip");

        assert_eq!(round_tripped, value);
    }

    #[test]
    fn typed_fact_proto_round_trips_fact_metadata() {
        let mut fact = fact!(
            uri!("poneglyph:cli"),
            uri!("spotify:album:signals"),
            uri!("spotify:displayName"),
            Value::text("Signals")
        );
        fact.fact_id = uri!("poneglyph:fact:1");
        fact.tx_id = Some(uri!("poneglyph:tx:1"));
        fact.stated_at = Utc
            .with_ymd_and_hms(1982, 9, 9, 12, 0, 0)
            .single()
            .expect("timestamp");

        let round_tripped = fact_from_proto(fact_to_proto(&fact)).expect("fact round-trip");

        assert_eq!(round_tripped, fact);
    }

    #[test]
    fn typed_active_fact_proto_round_trips_fact_metadata() {
        let fact = ActiveFact {
            source: uri!("poneglyph:cli"),
            entity: uri!("spotify:album:signals"),
            field: uri!("spotify:displayName"),
            value: Value::text("Signals"),
            fact_id: uri!("poneglyph:fact:1"),
            tx_id: uri!("poneglyph:tx:1"),
        };

        let round_tripped =
            active_fact_from_proto(active_fact_to_proto(&fact)).expect("active fact round-trip");

        assert_eq!(round_tripped, fact);
    }

    #[test]
    fn typed_entity_proto_round_trips_field_values() {
        let mut fields = BTreeMap::new();
        fields.insert(uri!("spotify:displayName"), Value::text("Signals"));
        let entity = Entity {
            uri: uri!("spotify:album:signals"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields,
        };

        let round_tripped = entity_from_proto(entity_to_proto(&entity)).expect("entity round-trip");

        assert_eq!(round_tripped, entity);
    }

    #[test]
    fn typed_search_hit_proto_round_trips_score_and_uri() {
        let hit = poneglyph_core::SearchHit {
            entity_uri: uri!("spotify:album:signals"),
            score: 1.5,
        };

        let round_tripped =
            search_hit_from_proto(search_hit_to_proto(&hit)).expect("search hit round-trip");

        assert_eq!(round_tripped, hit);
    }

    #[test]
    fn typed_query_response_proto_preserves_bindings() {
        let rows = query_response_to_proto(&[datafox::Substitution::from_bindings([
            (
                "Album".to_string(),
                datafox::Value::from("spotify:album:2112"),
            ),
            ("Year".to_string(), datafox::Value::integer(1976)),
        ])]);

        assert_eq!(rows.rows.len(), 1);
        assert_eq!(rows.rows[0].bindings.len(), 2);
        assert_eq!(rows.rows[0].bindings[0].variable, "Album");
    }

    #[test]
    fn typed_schema_proto_round_trips_entries() {
        let schema = SchemaDefinition {
            base: BaseSchema {
                namespaces: vec![NamespaceSchema {
                    uri: uri!("schema:namespace"),
                    name: Some("Schema".to_string()),
                    doc: None,
                }],
                ..Default::default()
            },
            fields: vec![FieldSchema {
                uri: uri!("spotify:displayName"),
                name: Some("Display name".to_string()),
                doc: None,
                same_as: Some(uri!("schema:name")),
                domain: Some(uri!("spotify:album")),
                range: None,
                value_type: Some("text".to_string()),
                cardinality: Some("one".to_string()),
                deprecated: Some(false),
                identity: Some(true),
            }],
            ..Default::default()
        };

        let round_tripped = schema_from_proto(schema_to_proto(&schema)).expect("schema round-trip");

        assert_eq!(round_tripped, schema);
    }

    #[test]
    fn typed_value_proto_rejects_missing_value_kind() {
        let error = value_from_proto(super::proto::Value { kind: None })
            .expect_err("missing kind should fail");

        assert!(error.contains("missing value kind"));
    }

    #[tokio::test]
    async fn query_legacy_json_matches_typed_row_count() {
        let (api, runtime) = api_with_runtime().await;
        runtime
            .state_facts(vec![fact!(
                uri!("spotify:album:signals"),
                uri!("spotify:displayName"),
                Value::text("Signals")
            )])
            .await
            .expect("state facts");
        let request = QueryRequest {
            expression: r#"spotify:displayName(Album, "Signals")"#.to_string(),
        };

        let legacy = api
            .query(Request::new(request.clone()))
            .await
            .expect("legacy query")
            .into_inner();
        let typed = api
            .query_typed(Request::new(request))
            .await
            .expect("typed query")
            .into_inner();
        let substitutions = serde_json::from_str::<Vec<datafox::Substitution>>(&legacy.json)
            .expect("legacy substitutions json");

        assert_eq!(substitutions.len(), typed.rows.len());
    }

    #[tokio::test]
    async fn get_schema_legacy_json_matches_typed_base_schema() {
        let api = api().await;

        let legacy = api
            .get_schema(Request::new(GetSchemaRequest {}))
            .await
            .expect("legacy schema")
            .into_inner();
        let typed = api
            .get_schema_typed(Request::new(GetSchemaRequest {}))
            .await
            .expect("typed schema")
            .into_inner();
        let legacy_schema =
            serde_json::from_str::<SchemaDefinition>(&legacy.json).expect("legacy schema json");
        let typed_schema = schema_from_proto(typed).expect("typed schema proto");

        assert_eq!(legacy_schema.base, typed_schema.base);
    }

    #[tokio::test]
    async fn query_typed_returns_typed_bindings() {
        let (api, runtime) = api_with_runtime().await;
        runtime
            .state_facts(vec![fact!(
                uri!("spotify:album:signals"),
                uri!("spotify:displayName"),
                Value::text("Signals")
            )])
            .await
            .expect("state facts");

        let response = api
            .query_typed(Request::new(QueryRequest {
                expression: r#"spotify:displayName(Album, "Signals")"#.to_string(),
            }))
            .await
            .expect("query")
            .into_inner();

        assert_eq!(response.rows.len(), 1);
        assert_eq!(response.rows[0].bindings.len(), 1);
        assert_eq!(response.rows[0].bindings[0].variable, "Album");
    }

    #[tokio::test]
    async fn query_typed_rejects_invalid_queries() {
        let error = api()
            .await
            .query_typed(Request::new(QueryRequest {
                expression: "not a query".to_string(),
            }))
            .await
            .expect_err("invalid query should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
    }

    fn signals_entity() -> Entity {
        Entity {
            uri: uri!("spotify:album:signals"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields: BTreeMap::from([(uri!("spotify:displayName"), Value::text("Signals"))]),
        }
    }

    #[tokio::test]
    async fn get_entity_typed_returns_none_for_missing_entities() {
        let response = api()
            .await
            .get_entity_typed(Request::new(GetEntityRequest {
                uri: "spotify:album:missing".to_string(),
            }))
            .await
            .expect("get entity")
            .into_inner();

        assert!(response.entity.is_none());
    }

    #[tokio::test]
    async fn get_entity_legacy_json_matches_typed_entity() {
        let (api, runtime) = api_with_runtime().await;
        runtime
            .entity_store()
            .put_entity(signals_entity(), None)
            .await
            .expect("put entity");
        let request = GetEntityRequest {
            uri: "spotify:album:signals".to_string(),
        };

        let legacy = api
            .get_entity(Request::new(request.clone()))
            .await
            .expect("legacy entity")
            .into_inner();
        let typed = api
            .get_entity_typed(Request::new(request))
            .await
            .expect("typed entity")
            .into_inner();
        let legacy_entity =
            serde_json::from_str::<Option<Entity>>(&legacy.json).expect("legacy entity json");
        let typed_entity = typed
            .entity
            .map(entity_from_proto)
            .transpose()
            .expect("entity proto");

        assert_eq!(legacy_entity, typed_entity);
    }

    #[tokio::test]
    async fn list_entities_legacy_json_matches_typed_entities() {
        let (api, runtime) = api_with_runtime().await;
        runtime
            .entity_store()
            .put_entity(signals_entity(), None)
            .await
            .expect("put entity");
        let request = ListEntitiesRequest {
            limit: 100,
            offset: 0,
        };

        let legacy = api
            .list_entities(Request::new(request))
            .await
            .expect("legacy entities")
            .into_inner();
        let typed = api
            .list_entities_typed(Request::new(request))
            .await
            .expect("typed entities")
            .into_inner();
        let legacy_entities =
            serde_json::from_str::<Vec<Entity>>(&legacy.json).expect("legacy entities json");
        let typed_entities = typed
            .entities
            .into_iter()
            .map(entity_from_proto)
            .collect::<Result<Vec<_>, _>>()
            .expect("typed entities");

        assert_eq!(legacy_entities, typed_entities);
    }

    #[tokio::test]
    async fn search_entities_legacy_json_matches_typed_hits() {
        let (api, runtime) = api_with_runtime().await;
        runtime
            .search_projection()
            .handle_events(ProjectionBatch {
                entities: vec![signals_entity()],
            })
            .await
            .expect("index entity");
        let request = SearchEntitiesRequest {
            query: "Signals".to_string(),
            limit: 100,
        };

        let legacy = api
            .search_entities(Request::new(request.clone()))
            .await
            .expect("legacy search")
            .into_inner();
        let typed = api
            .search_entities_typed(Request::new(request))
            .await
            .expect("typed search")
            .into_inner();
        let legacy_hits =
            serde_json::from_str::<Vec<SearchHit>>(&legacy.json).expect("legacy search json");
        let typed_hits = typed
            .hits
            .into_iter()
            .map(search_hit_from_proto)
            .collect::<Result<Vec<_>, _>>()
            .expect("typed search hits");

        assert_eq!(legacy_hits, typed_hits);
    }

    #[tokio::test]
    async fn state_fact_legacy_states_one_json_fact() {
        let fact = fact!(
            uri!("spotify:album:signals"),
            uri!("spotify:displayName"),
            Value::text("Signals")
        );
        let fact_id = fact.fact_id.to_string();
        let response = api()
            .await
            .state_fact(Request::new(StateFactRequest {
                fact_json: serde_json::to_string(&fact).expect("fact json"),
            }))
            .await
            .expect("state fact")
            .into_inner();

        assert_eq!(response.fact_id, fact_id);
        assert_eq!(response.fact_ids, vec![fact_id]);
        assert!(!response.tx_id.is_empty());
    }

    #[tokio::test]
    async fn state_facts_legacy_rejects_empty_batches() {
        let error = api()
            .await
            .state_facts(Request::new(StateFactsRequest { fact_json: vec![] }))
            .await
            .expect_err("empty batch should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("empty fact batch"));
    }

    #[tokio::test]
    async fn state_fact_typed_states_one_fact() {
        let fact = fact!(
            uri!("spotify:album:signals"),
            uri!("spotify:displayName"),
            Value::text("Signals")
        );
        let fact_id = fact.fact_id.to_string();
        let response = api()
            .await
            .state_fact_typed(Request::new(StateFactTypedRequest {
                fact: Some(fact_to_proto(&fact)),
            }))
            .await
            .expect("state fact")
            .into_inner();

        assert_eq!(response.fact_id, fact_id);
        assert_eq!(response.fact_ids, vec![fact_id]);
        assert!(!response.tx_id.is_empty());
    }

    #[tokio::test]
    async fn state_facts_typed_rejects_empty_batches() {
        let error = api()
            .await
            .state_facts_typed(Request::new(StateFactsTypedRequest { facts: vec![] }))
            .await
            .expect_err("empty batch should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("empty fact batch"));
    }

    #[tokio::test]
    async fn list_facts_rejects_zero_limit() {
        let error = api()
            .await
            .list_facts(Request::new(ListFactsRequest {
                entity_uri: String::new(),
                tx_id: String::new(),
                active: false,
                limit: 0,
                offset: 0,
            }))
            .await
            .expect_err("zero limit should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("greater than 0"));
    }

    #[tokio::test]
    async fn list_facts_rejects_conflicting_filters() {
        let error = api()
            .await
            .list_facts(Request::new(ListFactsRequest {
                entity_uri: "spotify:album:signals".to_string(),
                tx_id: "poneglyph:tx:1".to_string(),
                active: false,
                limit: 100,
                offset: 0,
            }))
            .await
            .expect_err("conflicting filters should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("only one filter"));
    }

    #[tokio::test]
    async fn list_active_facts_rejects_tx_filter() {
        let error = api()
            .await
            .list_facts(Request::new(ListFactsRequest {
                entity_uri: String::new(),
                tx_id: "poneglyph:tx:1".to_string(),
                active: true,
                limit: 100,
                offset: 0,
            }))
            .await
            .expect_err("active tx filtering should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("does not support tx_id"));
    }

    #[tokio::test]
    async fn list_facts_applies_limit_and_offset() {
        let (api, runtime) = api_with_runtime().await;
        let tx_id = runtime
            .state_facts(vec![
                fact!(
                    uri!("spotify:album:a-farewell-to-kings"),
                    uri!("spotify:displayName"),
                    Value::text("A Farewell to Kings")
                ),
                fact!(
                    uri!("spotify:album:hemispheres"),
                    uri!("spotify:displayName"),
                    Value::text("Hemispheres")
                ),
            ])
            .await
            .expect("state facts");

        let first_response = api
            .list_facts(Request::new(ListFactsRequest {
                entity_uri: String::new(),
                tx_id: tx_id.to_string(),
                active: false,
                limit: 1,
                offset: 0,
            }))
            .await
            .expect("list facts")
            .into_inner();
        let first_facts =
            serde_json::from_str::<Vec<Fact>>(&first_response.json).expect("facts json");

        let second_response = api
            .list_facts(Request::new(ListFactsRequest {
                entity_uri: String::new(),
                tx_id: tx_id.to_string(),
                active: false,
                limit: 1,
                offset: 1,
            }))
            .await
            .expect("list facts")
            .into_inner();
        let second_facts =
            serde_json::from_str::<Vec<Fact>>(&second_response.json).expect("facts json");

        assert_eq!(first_facts.len(), 1);
        assert_eq!(second_facts.len(), 1);
        assert_ne!(first_facts[0].fact_id, second_facts[0].fact_id);
    }

    #[tokio::test]
    async fn list_active_facts_applies_limit_and_offset() {
        let (api, runtime) = api_with_runtime().await;
        runtime
            .state_facts(vec![
                fact!(
                    uri!("spotify:album:permanent-waves"),
                    uri!("spotify:displayName"),
                    Value::text("Permanent Waves")
                ),
                fact!(
                    uri!("spotify:album:moving-pictures"),
                    uri!("spotify:displayName"),
                    Value::text("Moving Pictures")
                ),
            ])
            .await
            .expect("state facts");

        let first_response = api
            .list_facts(Request::new(ListFactsRequest {
                entity_uri: String::new(),
                tx_id: String::new(),
                active: true,
                limit: 1,
                offset: 0,
            }))
            .await
            .expect("list active facts")
            .into_inner();
        let first_facts = serde_json::from_str::<Vec<ActiveFact>>(&first_response.json)
            .expect("active facts json");

        let second_response = api
            .list_facts(Request::new(ListFactsRequest {
                entity_uri: String::new(),
                tx_id: String::new(),
                active: true,
                limit: 1,
                offset: 1,
            }))
            .await
            .expect("list active facts")
            .into_inner();
        let second_facts = serde_json::from_str::<Vec<ActiveFact>>(&second_response.json)
            .expect("active facts json");

        assert_eq!(first_facts.len(), 1);
        assert_eq!(second_facts.len(), 1);
        assert_ne!(first_facts[0].fact_id, second_facts[0].fact_id);
    }

    #[tokio::test]
    async fn list_facts_legacy_json_matches_typed_log_facts() {
        let (api, runtime) = api_with_runtime().await;
        let tx_id = runtime
            .state_facts(vec![fact!(
                uri!("spotify:album:signals"),
                uri!("spotify:displayName"),
                Value::text("Signals")
            )])
            .await
            .expect("state facts");
        let request = ListFactsRequest {
            entity_uri: String::new(),
            tx_id: tx_id.to_string(),
            active: false,
            limit: 100,
            offset: 0,
        };

        let legacy = api
            .list_facts(Request::new(request.clone()))
            .await
            .expect("legacy facts")
            .into_inner();
        let typed = api
            .list_facts_typed(Request::new(request))
            .await
            .expect("typed facts")
            .into_inner();
        let legacy_facts =
            serde_json::from_str::<Vec<Fact>>(&legacy.json).expect("legacy facts json");
        let typed_facts = typed
            .facts
            .into_iter()
            .map(fact_from_proto)
            .collect::<Result<Vec<_>, _>>()
            .expect("typed facts");

        assert_eq!(legacy_facts, typed_facts);
    }

    #[tokio::test]
    async fn list_facts_typed_returns_typed_log_facts() {
        let (api, runtime) = api_with_runtime().await;
        let tx_id = runtime
            .state_facts(vec![fact!(
                uri!("spotify:album:signals"),
                uri!("spotify:displayName"),
                Value::text("Signals")
            )])
            .await
            .expect("state facts");

        let response = api
            .list_facts_typed(Request::new(ListFactsRequest {
                entity_uri: String::new(),
                tx_id: tx_id.to_string(),
                active: false,
                limit: 100,
                offset: 0,
            }))
            .await
            .expect("typed facts")
            .into_inner();

        assert!(!response.active);
        assert_eq!(response.facts.len(), 1);
        assert!(response.active_facts.is_empty());
        assert_eq!(response.facts[0].tx_id, tx_id.to_string());
        assert_eq!(response.facts[0].entity, "spotify:album:signals");
    }

    #[tokio::test]
    async fn list_facts_typed_returns_typed_active_facts() {
        let (api, runtime) = api_with_runtime().await;
        runtime
            .state_facts(vec![fact!(
                uri!("spotify:album:signals"),
                uri!("spotify:displayName"),
                Value::text("Signals")
            )])
            .await
            .expect("state facts");

        let response = api
            .list_facts_typed(Request::new(ListFactsRequest {
                entity_uri: "spotify:album:signals".to_string(),
                tx_id: String::new(),
                active: true,
                limit: 100,
                offset: 0,
            }))
            .await
            .expect("typed active facts")
            .into_inner();

        assert!(response.active);
        assert!(response.facts.is_empty());
        assert_eq!(response.active_facts.len(), 1);
        assert_eq!(response.active_facts[0].entity, "spotify:album:signals");
    }

    #[tokio::test]
    async fn list_entities_rejects_zero_limit() {
        let error = api()
            .await
            .list_entities(Request::new(ListEntitiesRequest {
                limit: 0,
                offset: 0,
            }))
            .await
            .expect_err("zero limit should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("greater than 0"));
    }

    #[tokio::test]
    async fn list_entities_typed_rejects_zero_limit() {
        let error = api()
            .await
            .list_entities_typed(Request::new(ListEntitiesRequest {
                limit: 0,
                offset: 0,
            }))
            .await
            .expect_err("zero limit should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("greater than 0"));
    }

    #[tokio::test]
    async fn search_entities_rejects_zero_limit() {
        let error = api()
            .await
            .search_entities(Request::new(SearchEntitiesRequest {
                query: "Signals".to_string(),
                limit: 0,
            }))
            .await
            .expect_err("zero limit should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("greater than 0"));
    }

    #[tokio::test]
    async fn search_entities_typed_rejects_zero_limit() {
        let error = api()
            .await
            .search_entities_typed(Request::new(SearchEntitiesRequest {
                query: "Signals".to_string(),
                limit: 0,
            }))
            .await
            .expect_err("zero limit should fail");

        assert_eq!(error.code(), Code::InvalidArgument);
        assert!(error.message().contains("greater than 0"));
    }
}
