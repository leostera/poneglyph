use std::sync::Arc;

use crate::{
    Entity, EntityStore, Fact, FactService, PoneResult, PoneglyphConfig, Query, QueryEngine,
    QueryResult, SearchHit, SearchProjection, SqliteEntityStore, SqliteFactStore, Store, Uri,
    Workspace,
};
use tokio::sync::mpsc;

/// Assembled Poneglyph runtime dependencies.
pub struct Poneglyph {
    workspace: Workspace,
    config: PoneglyphConfig,
    fact_service: Arc<FactService>,
    entity_store: Arc<dyn EntityStore>,
    search_projection: Arc<SearchProjection>,
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

    pub fn search_projection(&self) -> Arc<SearchProjection> {
        self.search_projection.clone()
    }

    pub fn query_engine(&self) -> &QueryEngine {
        &self.query_engine
    }

    pub async fn state_facts(&self, facts: mpsc::Receiver<Fact>) -> PoneResult<Uri> {
        self.fact_service.state_facts(facts).await
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
        self.search_projection.search(query, limit)
    }
}

#[derive(Default)]
pub struct PoneglyphBuilder {
    workspace: Option<Workspace>,
    config: Option<PoneglyphConfig>,
    fact_service: Option<Arc<FactService>>,
    entity_store: Option<Arc<dyn EntityStore>>,
    search_projection: Option<Arc<SearchProjection>>,
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

    pub fn with_search_projection(mut self, search_projection: SearchProjection) -> Self {
        self.search_projection = Some(Arc::new(search_projection));
        self
    }

    pub fn with_search_projection_arc(mut self, search_projection: Arc<SearchProjection>) -> Self {
        self.search_projection = Some(search_projection);
        self
    }

    pub async fn build(self) -> PoneResult<Poneglyph> {
        let workspace = match self.workspace {
            Some(workspace) => workspace,
            None => Workspace::new()?,
        };
        workspace.ensure()?;

        let config = match self.config {
            Some(config) => config,
            None => PoneglyphConfig::load_from(&workspace).await?,
        };

        let fact_service = match self.fact_service {
            Some(fact_service) => fact_service,
            None => {
                let store: Arc<dyn Store> =
                    Arc::new(SqliteFactStore::open(workspace.facts_db_path()).await?);
                Arc::new(FactService::builder().with_store_arc(store).build()?)
            }
        };

        let entity_store = match self.entity_store {
            Some(entity_store) => entity_store,
            None => Arc::new(SqliteEntityStore::open(workspace.entities_db_path()).await?),
        };

        let search_projection = match self.search_projection {
            Some(search_projection) => search_projection,
            None => Arc::new(SearchProjection::open(workspace.search_db_path())?),
        };

        let query_engine = QueryEngine::new(fact_service.clone());

        Ok(Poneglyph {
            workspace,
            config,
            fact_service,
            entity_store,
            search_projection,
            query_engine,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use tempfile::tempdir;
    use tokio::sync::mpsc;

    use crate::{
        Entity, InMemoryEntityStore, InMemoryFactStore, Poneglyph, PoneglyphConfig, Projection,
        ProjectionBatch, SearchProjection, Value, Workspace, fact, uri,
    };

    fn fact_stream(facts: Vec<crate::Fact>) -> mpsc::Receiver<crate::Fact> {
        let (tx, rx) = mpsc::channel(facts.len().max(1));
        tokio::spawn(async move {
            for fact in facts {
                if tx.send(fact).await.is_err() {
                    break;
                }
            }
        });
        rx
    }

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
        assert!(workspace.facts_db_path().exists());
        assert!(workspace.entities_db_path().exists());
        assert!(workspace.search_db_path().exists());
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
        let search_projection =
            Arc::new(SearchProjection::create_in_memory().expect("search projection"));

        let poneglyph = Poneglyph::builder()
            .with_workspace(workspace.clone())
            .with_config(config.clone())
            .with_fact_service(fact_service)
            .with_entity_store_arc(entity_store.clone())
            .with_search_projection_arc(search_projection.clone())
            .build()
            .await
            .expect("runtime");

        assert_eq!(poneglyph.workspace(), &workspace);
        assert_eq!(poneglyph.config(), &config);
        assert!(Arc::ptr_eq(&poneglyph.entity_store(), &entity_store));
        assert!(Arc::ptr_eq(
            &poneglyph.search_projection(),
            &search_projection
        ));
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
            .with_search_projection(
                SearchProjection::create_in_memory().expect("search projection"),
            )
            .build()
            .await
            .expect("runtime");

        let album = uri!("spotify:album:2112");
        poneglyph
            .state_facts(fact_stream(vec![fact!(
                album.clone(),
                uri!("spotify:displayName"),
                Value::text("2112")
            )]))
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
            .with_search_projection(
                SearchProjection::create_in_memory().expect("search projection"),
            )
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
    async fn runtime_search_delegates_to_search_projection() {
        let search_projection = Arc::new(SearchProjection::create_in_memory().expect("projection"));
        let entity = Entity {
            uri: uri!("spotify:album:counterparts"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields: BTreeMap::from([(uri!("spotify:displayName"), Value::text("Counterparts"))]),
        };
        search_projection
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
            .with_search_projection_arc(search_projection)
            .build()
            .await
            .expect("runtime");

        let hits = poneglyph.search("Counterparts", 10).expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_uri, entity.uri);
    }
}
