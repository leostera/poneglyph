pub mod proto {
    tonic::include_proto!("poneglyph.daemon.v1");
}

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, NaiveDate, Utc};
use poneglyph_core::{ActiveFilter, Fact, Filter, PoneResult, Poneglyph, Query, Uri, Value};
use serde::Serialize;
use tonic::{Request, Response, Status};

use self::proto::poneglyph_daemon_server::PoneglyphDaemon;
use self::proto::{
    GetEntityRequest, GetSchemaRequest, JsonResponse, ListEntitiesRequest, ListFactsRequest,
    QueryRequest, RetractFactByIdRequest, SearchEntitiesRequest, ShutdownRequest, ShutdownResponse,
    StateFactRequest, StateFactResponse, StateFactsRequest, StatusRequest, StatusResponse,
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
        let fact_id = fact.fact_id.to_string();
        let tx_id = self
            .poneglyph
            .state_facts(vec![fact])
            .await
            .map_err(internal)?;

        Ok(Response::new(StateFactResponse {
            tx_id: tx_id.to_string(),
            fact_id: fact_id.clone(),
            fact_ids: vec![fact_id],
        }))
    }

    async fn state_facts(
        &self,
        request: Request<StateFactsRequest>,
    ) -> Result<Response<StateFactResponse>, Status> {
        let facts = request
            .into_inner()
            .fact_json
            .into_iter()
            .map(|json| {
                serde_json::from_str::<Fact>(&json)
                    .map_err(|error| Status::invalid_argument(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;

        if facts.is_empty() {
            return Err(Status::invalid_argument("empty fact batch"));
        }

        let fact_ids = facts
            .iter()
            .map(|fact| fact.fact_id.to_string())
            .collect::<Vec<_>>();
        let tx_id = self.poneglyph.state_facts(facts).await.map_err(internal)?;

        Ok(Response::new(StateFactResponse {
            tx_id: tx_id.to_string(),
            fact_id: fact_ids.first().cloned().unwrap_or_default(),
            fact_ids,
        }))
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
        let request = request.into_inner();
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
                let facts = pagination.apply(collect_results(facts).await?);
                json_response(&facts)
            }
            FactListFilter::Log(filter) => {
                let facts = self
                    .poneglyph
                    .fact_service()
                    .get_facts(filter)
                    .await
                    .map_err(internal)?;
                let facts = pagination.apply(collect_results(facts).await?);
                json_response(&facts)
            }
        }
    }

    async fn query(
        &self,
        request: Request<QueryRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let query = Query::parse(&request.into_inner().expression).map_err(invalid_argument)?;
        let result = self.poneglyph.query(query).await.map_err(internal)?;
        json_response(result.substitutions())
    }

    async fn get_entity(
        &self,
        request: Request<GetEntityRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let uri = parse_uri(request.into_inner().uri)?;
        let entity = self.poneglyph.get_entity(&uri).await.map_err(internal)?;
        json_response(&entity)
    }

    async fn list_entities(
        &self,
        request: Request<ListEntitiesRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let request = request.into_inner();
        let pagination = Pagination::try_from_limit_offset(request.limit, request.offset)?;
        let entities = self
            .poneglyph
            .list_entities(pagination.limit, pagination.offset)
            .await
            .map_err(internal)?;
        json_response(&entities)
    }

    async fn search_entities(
        &self,
        request: Request<SearchEntitiesRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let request = request.into_inner();
        let pagination = Pagination::try_from_limit_offset(request.limit, 0)?;
        let hits = self
            .poneglyph
            .search(&request.query, pagination.limit)
            .map_err(internal)?;
        json_response(&hits)
    }

    async fn get_schema(
        &self,
        _request: Request<GetSchemaRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let schema = self.poneglyph.get_schema().await.map_err(internal)?;
        json_response(&schema)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use std::collections::BTreeMap;

    use chrono::{NaiveDate, TimeZone, Utc};
    use poneglyph_core::{
        ActiveFact, Fact, InMemoryEntityStore, InMemoryFactStore, Poneglyph, SearchProjection,
        Value, fact, uri,
    };
    use tonic::{Code, Request};

    use super::proto::poneglyph_daemon_server::PoneglyphDaemon;
    use super::proto::{ListEntitiesRequest, ListFactsRequest, SearchEntitiesRequest};
    use super::{DaemonApi, fact_from_proto, fact_to_proto, value_from_proto, value_to_proto};

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
    fn typed_value_proto_rejects_missing_value_kind() {
        let error = value_from_proto(super::proto::Value { kind: None })
            .expect_err("missing kind should fail");

        assert!(error.contains("missing value kind"));
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
}
