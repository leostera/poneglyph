pub mod proto {
    tonic::include_proto!("poneglyph.daemon.v1");
}

use std::sync::{Arc, Mutex};
use std::time::Instant;

use poneglyph::{Fact, Filter, Poneglyph, Query, Uri};
use tonic::{Request, Response, Status};

use self::proto::poneglyph_daemon_server::PoneglyphDaemon;
use self::proto::{
    GetEntityRequest, GetSchemaRequest, JsonResponse, QueryRequest, RetractFactByIdRequest,
    ShutdownRequest, ShutdownResponse, StateFactRequest, StateFactResponse, StatusRequest,
    StatusResponse,
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
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let tx_id = self
            .poneglyph
            .state_facts(vec![fact])
            .await
            .map_err(|error| Status::internal(error.to_string()))?;

        Ok(Response::new(StateFactResponse {
            tx_id: tx_id.to_string(),
        }))
    }

    async fn retract_fact_by_id(
        &self,
        request: Request<RetractFactByIdRequest>,
    ) -> Result<Response<StateFactResponse>, Status> {
        let fact_id = Uri::parse(request.into_inner().fact_id)
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let mut facts = self
            .poneglyph
            .fact_service()
            .get_facts(Filter::ById(fact_id.clone()))
            .await
            .map_err(|error| Status::internal(error.to_string()))?;
        let fact = facts
            .recv()
            .await
            .ok_or_else(|| Status::not_found(format!("fact `{fact_id}` not found")))?
            .map_err(|error| Status::internal(error.to_string()))?;
        let retraction = Fact::builder()
            .source(fact.source)
            .entity(fact.entity)
            .field(fact.field)
            .value(fact.value)
            .retract()
            .build()
            .map_err(|error| Status::internal(error.to_string()))?;
        let tx_id = self
            .poneglyph
            .state_facts(vec![retraction])
            .await
            .map_err(|error| Status::internal(error.to_string()))?;

        Ok(Response::new(StateFactResponse {
            tx_id: tx_id.to_string(),
        }))
    }

    async fn query(
        &self,
        request: Request<QueryRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let query = Query::parse(&request.into_inner().expression)
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let result = self
            .poneglyph
            .query(query)
            .await
            .map_err(|error| Status::internal(error.to_string()))?;
        let json = serde_json::to_string_pretty(result.substitutions())
            .map_err(|error| Status::internal(error.to_string()))?;

        Ok(Response::new(JsonResponse { json }))
    }

    async fn get_entity(
        &self,
        request: Request<GetEntityRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let uri = Uri::parse(request.into_inner().uri)
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let entity = self
            .poneglyph
            .get_entity(&uri)
            .await
            .map_err(|error| Status::internal(error.to_string()))?;
        let json = serde_json::to_string_pretty(&entity)
            .map_err(|error| Status::internal(error.to_string()))?;

        Ok(Response::new(JsonResponse { json }))
    }

    async fn get_schema(
        &self,
        _request: Request<GetSchemaRequest>,
    ) -> Result<Response<JsonResponse>, Status> {
        let schema = self
            .poneglyph
            .get_schema()
            .await
            .map_err(|error| Status::internal(error.to_string()))?;
        let json = serde_json::to_string_pretty(&schema)
            .map_err(|error| Status::internal(error.to_string()))?;

        Ok(Response::new(JsonResponse { json }))
    }
}
