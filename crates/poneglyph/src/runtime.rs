use std::sync::Arc;

use crate::{
    EntityStore, FactService, PoneResult, PoneglyphConfig, QueryEngine, SearchProjection,
    SqliteEntityStore, SqliteFactStore, Store, Workspace,
};

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
    use std::sync::Arc;

    use tempfile::tempdir;

    use crate::{
        InMemoryEntityStore, InMemoryFactStore, Poneglyph, PoneglyphConfig, SearchProjection,
        Workspace,
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
}
