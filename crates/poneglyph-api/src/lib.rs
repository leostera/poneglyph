pub mod proto {
    tonic::include_proto!("poneglyph.daemon.v1");
}

use std::sync::{Arc, Mutex};
use std::time::Instant;

use poneglyph_core::{ActiveFilter, Fact, Filter, PoneResult, Poneglyph, Query, Uri};
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

    use poneglyph_core::{
        ActiveFact, Fact, InMemoryEntityStore, InMemoryFactStore, Poneglyph, SearchProjection,
        Value, fact, uri,
    };
    use tonic::{Code, Request};

    use super::DaemonApi;
    use super::proto::poneglyph_daemon_server::PoneglyphDaemon;
    use super::proto::{ListEntitiesRequest, ListFactsRequest, SearchEntitiesRequest};

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
