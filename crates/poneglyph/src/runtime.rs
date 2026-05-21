use std::sync::Arc;

use crate::{
    Consolidator, Entity, EntityStore, Fact, FactService, PoneResult, PoneglyphConfig, Projection,
    ProjectionRunner, Query, QueryEngine, QueryResult, RuntimeStorageFactory, SchemaDefinition,
    SearchHit, SearchIndex, Uri, Workspace,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{debug, info};

/// Assembled Poneglyph runtime dependencies.
pub struct Poneglyph {
    workspace: Workspace,
    config: PoneglyphConfig,
    fact_service: Arc<FactService>,
    entity_store: Arc<dyn EntityStore>,
    search_index: Arc<dyn SearchIndex>,
    query_engine: QueryEngine,
}

impl Poneglyph {
    pub fn builder() -> PoneglyphBuilder {
        PoneglyphBuilder::default()
    }

    pub async fn open() -> PoneResult<Self> {
        Self::builder().build().await
    }

    pub async fn from_config(config: PoneglyphConfig) -> PoneResult<Self> {
        Self::builder().with_config(config).build().await
    }

    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }

    pub fn config(&self) -> &PoneglyphConfig {
        &self.config
    }

    pub fn fact_service(&self) -> Arc<FactService> {
        self.fact_service.clone()
    }

    pub fn entity_store(&self) -> Arc<dyn EntityStore> {
        self.entity_store.clone()
    }

    pub fn search_index(&self) -> Arc<dyn SearchIndex> {
        self.search_index.clone()
    }

    pub fn query_engine(&self) -> &QueryEngine {
        &self.query_engine
    }

    pub async fn state_facts(&self, facts: Vec<Fact>) -> PoneResult<Uri> {
        self.fact_service.state_facts(facts).await
    }

    pub async fn stream_facts(&self, facts: mpsc::Receiver<Fact>) -> PoneResult<Uri> {
        self.fact_service.stream_facts(facts).await
    }

    pub async fn query(&self, query: Query) -> PoneResult<QueryResult> {
        self.query_engine.query(query).await
    }

    pub async fn query_str(&self, source: &str) -> PoneResult<QueryResult> {
        self.query_engine.query_str(source).await
    }

    pub async fn get_entity(&self, entity_uri: &Uri) -> PoneResult<Option<Entity>> {
        self.entity_store.get_entity(entity_uri).await
    }

    pub fn search(&self, query: &str, limit: usize) -> PoneResult<Vec<SearchHit>> {
        self.search_index.search(query, limit)
    }

    pub async fn list_entities(&self, limit: usize, offset: usize) -> PoneResult<Vec<Entity>> {
        self.entity_store.list_entities(limit, offset).await
    }

    pub async fn get_schema(&self) -> PoneResult<SchemaDefinition> {
        self.fact_service.get_schema().await
    }

    pub async fn run(self: Arc<Self>) -> PoneResult<()> {
        let (consolidator_handle, projection_runner_handle) = self.spawn_background_workers()?;
        info!("poneglyph runtime workers started");
        tokio::try_join!(
            await_worker(consolidator_handle),
            await_worker(projection_runner_handle),
        )?;
        Ok(())
    }

    pub async fn repair(&self) -> PoneResult<()> {
        self.fact_service.store().repair().await?;
        Ok(())
    }
}

#[derive(Default)]
pub struct PoneglyphBuilder {
    workspace: Option<Workspace>,
    config: Option<PoneglyphConfig>,
    fact_service: Option<Arc<FactService>>,
    entity_store: Option<Arc<dyn EntityStore>>,
    search_index: Option<Arc<dyn SearchIndex>>,
    storage_factory: Option<Arc<dyn RuntimeStorageFactory>>,
}

impl PoneglyphBuilder {
    pub fn with_workspace(mut self, workspace: Workspace) -> Self {
        self.workspace = Some(workspace);
        self
    }

    pub fn with_config(mut self, config: PoneglyphConfig) -> Self {
        self.config = Some(config);
        self
    }

    pub fn with_fact_service(mut self, fact_service: FactService) -> Self {
        self.fact_service = Some(Arc::new(fact_service));
        self
    }

    pub fn with_fact_service_arc(mut self, fact_service: Arc<FactService>) -> Self {
        self.fact_service = Some(fact_service);
        self
    }

    pub fn with_entity_store<S>(mut self, entity_store: S) -> Self
    where
        S: EntityStore + 'static,
    {
        self.entity_store = Some(Arc::new(entity_store));
        self
    }

    pub fn with_entity_store_arc(mut self, entity_store: Arc<dyn EntityStore>) -> Self {
        self.entity_store = Some(entity_store);
        self
    }

    pub fn with_search_index<S>(mut self, search_index: S) -> Self
    where
        S: SearchIndex + 'static,
    {
        self.search_index = Some(Arc::new(search_index));
        self
    }

    pub fn with_search_index_arc(mut self, search_index: Arc<dyn SearchIndex>) -> Self {
        self.search_index = Some(search_index);
        self
    }

    pub fn with_storage_factory<F>(mut self, storage_factory: F) -> Self
    where
        F: RuntimeStorageFactory + 'static,
    {
        self.storage_factory = Some(Arc::new(storage_factory));
        self
    }

    pub fn with_storage_factory_arc(
        mut self,
        storage_factory: Arc<dyn RuntimeStorageFactory>,
    ) -> Self {
        self.storage_factory = Some(storage_factory);
        self
    }

    pub async fn build(self) -> PoneResult<Poneglyph> {
        let workspace = match self.workspace {
            Some(workspace) => workspace,
            None => Workspace::new()?,
        };
        workspace.ensure()?;
        debug!(workspace = %workspace.root().display(), "workspace ensured");

        let config = match self.config {
            Some(config) => config,
            None => PoneglyphConfig::load_from(&workspace).await?,
        };
        debug!(log_level = ?config.log_level, "runtime config loaded");

        let storage_factory = self
            .storage_factory
            .unwrap_or_else(|| Arc::new(crate::storage::DefaultRuntimeStorageFactory));

        let fact_service = match self.fact_service {
            Some(fact_service) => fact_service,
            None => {
                let store = storage_factory.open_fact_store(&workspace).await?;
                Arc::new(FactService::builder().with_store_arc(store).build()?)
            }
        };

        let entity_store = match self.entity_store {
            Some(entity_store) => entity_store,
            None => storage_factory.open_entity_store(&workspace).await?,
        };

        let search_index = match self.search_index {
            Some(search_index) => search_index,
            None => storage_factory.open_search_index(&workspace)?,
        };

        let query_engine = QueryEngine::new(fact_service.clone());
        crate::schema::ensure_base_schema(&fact_service).await?;
        info!("poneglyph runtime assembled");

        Ok(Poneglyph {
            workspace,
            config,
            fact_service,
            entity_store,
            search_index,
            query_engine,
        })
    }
}

type RuntimeWorkerHandle = JoinHandle<PoneResult<()>>;

impl Poneglyph {
    fn spawn_background_workers(&self) -> PoneResult<(RuntimeWorkerHandle, RuntimeWorkerHandle)> {
        let consolidator = Consolidator::builder()
            .with_entity_store_arc(self.entity_store.clone())
            .with_fact_subscription(self.fact_service.subscribe())
            .build()?;
        let projection_runner = ProjectionRunner::builder()
            .with_entity_subscription(consolidator.subscribe())
            .add_projection_arc(self.search_index.clone() as Arc<dyn Projection>)
            .build()?;

        Ok((consolidator.spawn(), projection_runner.spawn()))
    }
}

async fn await_worker(handle: JoinHandle<PoneResult<()>>) -> PoneResult<()> {
    handle
        .await
        .map_err(|source| crate::Error::RuntimeWorkerJoin { source })?
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use async_trait::async_trait;

    use tempfile::tempdir;
    use tokio::task::yield_now;
    use tokio::time::timeout;

    use crate::{
        Entity, EntityStore, InMemoryEntityStore, InMemoryFactStore, InMemorySearchIndex,
        PoneResult, Poneglyph, PoneglyphConfig, ProjectionBatch, RuntimeStorageFactory, Store,
        Value, Workspace, fact, uri,
    };

    #[tokio::test]
    async fn runtime_builder_assembles_workspace_backed_defaults() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let poneglyph = Poneglyph::builder()
            .with_workspace(workspace.clone())
            .build()
            .await
            .expect("runtime");

        assert_eq!(poneglyph.workspace(), &workspace);
        assert_eq!(poneglyph.config(), &PoneglyphConfig::default());
        assert!(workspace.store_dir().exists());
        assert!(!workspace.facts_db_path().exists());
        assert!(!workspace.entities_db_path().exists());
        assert!(!workspace.search_db_path().exists());
    }

    #[derive(Default)]
    struct TrackingStorageFactory {
        fact_store_opens: AtomicUsize,
        entity_store_opens: AtomicUsize,
        search_index_opens: AtomicUsize,
    }

    #[async_trait]
    impl RuntimeStorageFactory for TrackingStorageFactory {
        async fn open_fact_store(&self, _workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
            self.fact_store_opens.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(InMemoryFactStore::new()))
        }

        async fn open_entity_store(
            &self,
            _workspace: &Workspace,
        ) -> PoneResult<Arc<dyn EntityStore>> {
            self.entity_store_opens.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(InMemoryEntityStore::new()))
        }

        fn open_search_index(
            &self,
            _workspace: &Workspace,
        ) -> PoneResult<Arc<dyn crate::SearchIndex>> {
            self.search_index_opens.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(InMemorySearchIndex::new()))
        }
    }

    #[tokio::test]
    async fn runtime_builder_uses_injected_storage_factory() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let factory = Arc::new(TrackingStorageFactory::default());

        let poneglyph = Poneglyph::builder()
            .with_workspace(workspace.clone())
            .with_storage_factory_arc(factory.clone())
            .build()
            .await
            .expect("runtime");

        assert_eq!(poneglyph.workspace(), &workspace);
        assert_eq!(factory.fact_store_opens.load(Ordering::SeqCst), 1);
        assert_eq!(factory.entity_store_opens.load(Ordering::SeqCst), 1);
        assert_eq!(factory.search_index_opens.load(Ordering::SeqCst), 1);
        assert!(!workspace.facts_db_path().exists());
        assert!(!workspace.entities_db_path().exists());
        assert!(!workspace.search_db_path().exists());
    }

    #[tokio::test]
    async fn runtime_builder_honors_overrides() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let config = PoneglyphConfig::builder()
            .log_level(Some("trace".to_string()))
            .build()
            .expect("config");
        let fact_service = crate::FactService::builder()
            .with_store(InMemoryFactStore::new())
            .build()
            .expect("fact service");
        let entity_store: Arc<dyn crate::EntityStore> = Arc::new(InMemoryEntityStore::new());
        let search_index: Arc<dyn crate::SearchIndex> = Arc::new(InMemorySearchIndex::new());

        let poneglyph = Poneglyph::builder()
            .with_workspace(workspace.clone())
            .with_config(config.clone())
            .with_fact_service(fact_service)
            .with_entity_store_arc(entity_store.clone())
            .with_search_index_arc(search_index.clone())
            .build()
            .await
            .expect("runtime");

        assert_eq!(poneglyph.workspace(), &workspace);
        assert_eq!(poneglyph.config(), &config);
        assert!(Arc::ptr_eq(&poneglyph.entity_store(), &entity_store));
        assert!(Arc::ptr_eq(&poneglyph.search_index(), &search_index));
    }

    #[tokio::test]
    async fn runtime_state_facts_and_query_delegate_to_fact_services() {
        let fact_service = crate::FactService::builder()
            .with_store(InMemoryFactStore::new())
            .build()
            .expect("fact service");

        let poneglyph = Poneglyph::builder()
            .with_fact_service(fact_service)
            .with_entity_store(InMemoryEntityStore::new())
            .with_search_index(InMemorySearchIndex::new())
            .build()
            .await
            .expect("runtime");

        let album = uri!("spotify:album:2112");
        poneglyph
            .state_facts(vec![fact!(
                album.clone(),
                uri!("spotify:displayName"),
                Value::text("2112")
            )])
            .await
            .expect("state facts");

        let result = poneglyph
            .query_str(r#"spotify:displayName(Album, "2112")"#)
            .await
            .expect("query");

        assert_eq!(result.len(), 1);
        assert_eq!(
            result.substitutions()[0].lookup("Album"),
            Some(&datafox::Value::from(album.to_string()))
        );
    }

    #[tokio::test]
    async fn runtime_get_entity_delegates_to_entity_store() {
        let entity_store: Arc<dyn crate::EntityStore> = Arc::new(InMemoryEntityStore::new());
        let entity = Entity {
            uri: uri!("spotify:album:grace-under-pressure"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields: BTreeMap::from([(
                uri!("spotify:displayName"),
                Value::text("Grace Under Pressure"),
            )]),
        };
        entity_store
            .put_entity(entity.clone(), None)
            .await
            .expect("put entity");

        let poneglyph = Poneglyph::builder()
            .with_fact_service(
                crate::FactService::builder()
                    .with_store(InMemoryFactStore::new())
                    .build()
                    .expect("fact service"),
            )
            .with_entity_store_arc(entity_store)
            .with_search_index(InMemorySearchIndex::new())
            .build()
            .await
            .expect("runtime");

        let stored = poneglyph
            .get_entity(&entity.uri)
            .await
            .expect("get entity")
            .expect("entity");

        assert_eq!(stored, entity);
    }

    #[tokio::test]
    async fn runtime_search_delegates_to_search_index() {
        let search_index: Arc<dyn crate::SearchIndex> = Arc::new(InMemorySearchIndex::new());
        let entity = Entity {
            uri: uri!("spotify:album:counterparts"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields: BTreeMap::from([(uri!("spotify:displayName"), Value::text("Counterparts"))]),
        };
        search_index
            .handle_events(ProjectionBatch {
                entities: vec![entity.clone()],
            })
            .await
            .expect("handle events");

        let poneglyph = Poneglyph::builder()
            .with_fact_service(
                crate::FactService::builder()
                    .with_store(InMemoryFactStore::new())
                    .build()
                    .expect("fact service"),
            )
            .with_entity_store(InMemoryEntityStore::new())
            .with_search_index_arc(search_index)
            .build()
            .await
            .expect("runtime");

        let hits = poneglyph.search("Counterparts", 10).expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_uri, entity.uri);
    }

    #[tokio::test]
    async fn runtime_starts_background_workers_for_entity_and_search_updates() {
        let poneglyph = Arc::new(
            Poneglyph::builder()
                .with_fact_service(
                    crate::FactService::builder()
                        .with_store(InMemoryFactStore::new())
                        .build()
                        .expect("fact service"),
                )
                .with_entity_store(InMemoryEntityStore::new())
                .with_search_index(InMemorySearchIndex::new())
                .build()
                .await
                .expect("runtime"),
        );
        let runtime_task = tokio::spawn(poneglyph.clone().run());

        let album = uri!("spotify:album:hold-your-fire");
        poneglyph
            .state_facts(vec![fact!(
                album.clone(),
                uri!("spotify:displayName"),
                Value::text("Hold Your Fire")
            )])
            .await
            .expect("state facts");

        let entity = timeout(Duration::from_secs(1), async {
            loop {
                if let Some(entity) = poneglyph.get_entity(&album).await.expect("get entity") {
                    break entity;
                }
                yield_now().await;
            }
        })
        .await
        .expect("entity materializes");
        assert_eq!(
            entity.fields.get(&uri!("spotify:displayName")),
            Some(&Value::text("Hold Your Fire"))
        );

        timeout(Duration::from_secs(1), async {
            loop {
                let hits = poneglyph.search("Hold Your Fire", 10).expect("search");
                if hits.iter().any(|hit| hit.entity_uri == album) {
                    break;
                }
                yield_now().await;
            }
        })
        .await
        .expect("search index updates");

        runtime_task.abort();
    }

    #[tokio::test]
    async fn runtime_get_schema_exposes_base_schema_in_a_fresh_workspace() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let poneglyph = Poneglyph::builder()
            .with_workspace(workspace)
            .build()
            .await
            .expect("runtime");

        let schema = poneglyph.get_schema().await.expect("schema");

        assert!(
            schema
                .base
                .kinds
                .iter()
                .any(|kind| kind.uri.as_str() == "schema:field")
        );
        assert!(
            schema
                .fields
                .iter()
                .any(|field| field.uri.as_str() == "schema:type")
        );
    }
}
