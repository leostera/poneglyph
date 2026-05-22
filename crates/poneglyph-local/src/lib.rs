//! Local durable storage adapters for embedding Poneglyph in disk-backed daemons.
//!
//! Domain-specific daemons should use this crate when they want Poneglyph's
//! default workspace-backed runtime assembly. Graph semantics, facts, schemas,
//! entities, and queries remain in `poneglyph`; this crate supplies the
//! durable adapter boundary and repair/open helpers.
//!
//! This crate owns the local LSM fact store, SQLite entity store, and Tantivy
//! search projection. Other backend crates can implement the same `poneglyph`
//! storage traits for different primitives.
//!
//! ```no_run
//! use poneglyph::{Value, fact, uri};
//! use poneglyph_local::LocalWorkspace;
//!
//! async fn open_agent_memory() -> poneglyph::PoneResult<()> {
//!     let runtime = LocalWorkspace::at("./agent-memory.poneglyph").open().await?;
//!
//!     runtime
//!         .state_facts(vec![fact!(
//!             uri!("memory:item:first-note"),
//!             uri!("memory:title"),
//!             Value::text("First note")
//!         )])
//!         .await?;
//!
//!     let _rows = runtime
//!         .query_str(r#"memory:title(File, "First note")"#)
//!         .await?;
//!
//!     Ok(())
//! }
//! ```

mod entities;
mod facts;
mod projections;

use std::sync::Arc;

use async_trait::async_trait;
use poneglyph::{
    EntityStore, PoneResult, Poneglyph, PoneglyphConfig, RuntimeStorageFactory, SearchProjection,
    Store, Workspace,
};

pub use entities::SqliteEntityStore;
pub use facts::{LsmFactStore, SqliteFactStore};
pub use projections::TantivySearchProjection;

/// A disk-backed local Poneglyph workspace.
///
/// This is the preferred entry point for embedding Poneglyph in Rust applications.
#[derive(Debug, Clone)]
pub struct LocalWorkspace {
    workspace: Workspace,
}

impl LocalWorkspace {
    /// Creates a local workspace rooted at `~/.poneglyph`.
    pub fn new() -> PoneResult<Self> {
        Ok(Self::from_workspace(Workspace::new()?))
    }

    /// Creates a local workspace rooted at a custom path.
    pub fn at(root: impl Into<std::path::PathBuf>) -> Self {
        Self::from_workspace(Workspace::at(root))
    }

    /// Wraps an existing core workspace value.
    pub fn from_workspace(workspace: Workspace) -> Self {
        Self { workspace }
    }

    /// Returns the underlying core workspace.
    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }

    /// Consumes this wrapper and returns the underlying core workspace.
    pub fn into_workspace(self) -> Workspace {
        self.workspace
    }

    /// Opens a full runtime using local storage defaults.
    pub async fn open(&self) -> PoneResult<Poneglyph> {
        runtime_builder(self.workspace.clone()).build().await
    }

    /// Opens a full runtime with an explicit configuration.
    pub async fn open_with_config(&self, config: PoneglyphConfig) -> PoneResult<Poneglyph> {
        runtime_builder(self.workspace.clone())
            .with_config(config)
            .build()
            .await
    }

    /// Opens the default local fact store.
    pub async fn fact_store(&self) -> PoneResult<Arc<dyn Store>> {
        open_fact_store(&self.workspace).await
    }

    /// Opens the LSM fact store explicitly.
    pub fn lsm_fact_store(&self) -> PoneResult<Arc<dyn Store>> {
        open_lsm_fact_store(&self.workspace)
    }

    /// Opens the SQLite fact store explicitly.
    pub async fn sqlite_fact_store(&self) -> PoneResult<Arc<dyn Store>> {
        open_sqlite_fact_store(&self.workspace).await
    }

    /// Opens the entity projection store.
    pub async fn entity_store(&self) -> PoneResult<Arc<dyn EntityStore>> {
        open_entity_store(&self.workspace).await
    }

    /// Opens the search projection.
    pub fn search_projection(&self) -> PoneResult<Arc<TantivySearchProjection>> {
        open_search_projection(&self.workspace)
    }

    /// Opens the runtime and runs repair for this workspace.
    pub async fn repair(&self, config: PoneglyphConfig) -> PoneResult<()> {
        self.open_with_config(config).await?.repair().await
    }
}

impl From<Workspace> for LocalWorkspace {
    fn from(workspace: Workspace) -> Self {
        Self::from_workspace(workspace)
    }
}

/// Durable runtime storage factory backed by this crate's default local adapters.
pub struct LocalRuntimeStorageFactory;

/// Runtime storage factory backed by the local LSM fact store.
///
/// Entity and search projections remain on the SQLite/Tantivy adapters.
pub struct LsmRuntimeStorageFactory;

/// Runtime storage factory that prewarms the LSM active cache on open.
pub struct PrewarmedLsmRuntimeStorageFactory;

#[async_trait]
impl RuntimeStorageFactory for LocalRuntimeStorageFactory {
    async fn open_fact_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
        open_fact_store(workspace).await
    }

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
        open_entity_store(workspace).await
    }

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>> {
        open_search_projection(workspace).map(|projection| projection as Arc<dyn SearchProjection>)
    }
}

#[async_trait]
impl RuntimeStorageFactory for LsmRuntimeStorageFactory {
    async fn open_fact_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
        open_lsm_fact_store(workspace)
    }

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
        open_entity_store(workspace).await
    }

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>> {
        open_search_projection(workspace).map(|projection| projection as Arc<dyn SearchProjection>)
    }
}

#[async_trait]
impl RuntimeStorageFactory for PrewarmedLsmRuntimeStorageFactory {
    async fn open_fact_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
        let store = LsmFactStore::open(workspace.store_dir().join("facts.lsm"))?;
        store.prewarm_active_cache()?;
        Ok(Arc::new(store))
    }

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
        open_entity_store(workspace).await
    }

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>> {
        open_search_projection(workspace).map(|projection| projection as Arc<dyn SearchProjection>)
    }
}

/// Opens a full Poneglyph runtime using this crate's durable storage adapters.
///
/// This lets process-level crates depend on `poneglyph-local` for disk-backed
/// assembly while `poneglyph` retains semantic contracts and injectable
/// runtime construction.
pub async fn open_runtime(workspace: Workspace, config: PoneglyphConfig) -> PoneResult<Poneglyph> {
    LocalWorkspace::from_workspace(workspace)
        .open_with_config(config)
        .await
}

/// Opens a full Poneglyph runtime using the LSM fact store.
pub async fn open_lsm_runtime(
    workspace: Workspace,
    config: PoneglyphConfig,
) -> PoneResult<Poneglyph> {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_config(config)
        .with_storage_factory(LsmRuntimeStorageFactory)
        .build()
        .await
}

/// Opens a full Poneglyph runtime using durable storage and workspace config.
///
/// This is the preferred embedding helper for domain daemons that want the
/// standard disk-backed workspace layout and `config.toml` loading behavior.
pub async fn open_workspace(workspace: Workspace) -> PoneResult<Poneglyph> {
    LocalWorkspace::from_workspace(workspace).open().await
}

/// Opens a full Poneglyph runtime with the LSM fact store and workspace config.
pub async fn open_lsm_workspace(workspace: Workspace) -> PoneResult<Poneglyph> {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_storage_factory(LsmRuntimeStorageFactory)
        .build()
        .await
}

/// Opens an LSM-backed runtime and prewarms its active-fact decode cache.
pub async fn open_prewarmed_lsm_workspace(workspace: Workspace) -> PoneResult<Poneglyph> {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_storage_factory(PrewarmedLsmRuntimeStorageFactory)
        .build()
        .await
}

fn runtime_builder(workspace: Workspace) -> poneglyph::PoneglyphBuilder {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_storage_factory(LocalRuntimeStorageFactory)
}

/// Opens a runtime and runs storage repair for the workspace.
pub async fn repair_workspace(workspace: Workspace, config: PoneglyphConfig) -> PoneResult<()> {
    LocalWorkspace::from_workspace(workspace)
        .repair(config)
        .await
}

/// Opens the default durable fact store for a workspace.
pub async fn open_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    open_lsm_fact_store(workspace)
}

/// Opens the SQLite fact store explicitly.
pub async fn open_sqlite_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    Ok(Arc::new(
        SqliteFactStore::open(workspace.facts_db_path()).await?,
    ))
}

/// Opens the custom LSM fact store for a workspace.
pub fn open_lsm_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    let store = LsmFactStore::open(workspace.store_dir().join("facts.lsm"))?;
    if std::env::var("PONEGLYPH_LSM_PREWARM_ACTIVE_CACHE").is_ok_and(|value| value == "1") {
        store.prewarm_active_cache()?;
    }
    Ok(Arc::new(store))
}

/// Opens the default durable entity projection store for a workspace.
pub async fn open_entity_store(workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
    Ok(Arc::new(
        SqliteEntityStore::open(workspace.entities_db_path()).await?,
    ))
}

/// Opens the default durable search projection index for a workspace.
pub fn open_search_projection(workspace: &Workspace) -> PoneResult<Arc<TantivySearchProjection>> {
    Ok(Arc::new(TantivySearchProjection::open(
        workspace.search_db_path(),
    )?))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{
        LocalRuntimeStorageFactory, LocalWorkspace, open_fact_store, open_lsm_fact_store,
        open_lsm_workspace, open_runtime, open_sqlite_fact_store, repair_workspace,
    };
    use poneglyph::{Poneglyph, PoneglyphConfig, Workspace};

    #[tokio::test]
    async fn db_adapters_open_workspace_backed_defaults() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = LocalWorkspace::at(tempdir.path());
        workspace
            .workspace()
            .ensure()
            .expect("workspace directories");

        let _fact_store = workspace.fact_store().await.expect("fact store");
        let _entity_store = workspace.entity_store().await.expect("entity store");
        let _search_projection = workspace.search_projection().expect("search projection");

        assert!(
            workspace
                .workspace()
                .store_dir()
                .join("facts.lsm/facts.wal")
                .exists()
        );
        assert!(workspace.workspace().entities_db_path().exists());
        assert!(workspace.workspace().search_db_path().exists());
    }

    #[tokio::test]
    async fn db_storage_factory_opens_runtime_adapters_through_core_builder() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let runtime = Poneglyph::builder()
            .with_workspace(workspace.clone())
            .with_config(PoneglyphConfig::default())
            .with_storage_factory(LocalRuntimeStorageFactory)
            .build()
            .await
            .expect("runtime");

        assert_eq!(runtime.workspace().root(), workspace.root());
        assert!(workspace.store_dir().join("facts.lsm/facts.wal").exists());
        assert!(workspace.entities_db_path().exists());
        assert!(workspace.search_db_path().exists());
    }

    #[tokio::test]
    async fn db_lsm_fact_store_is_default_and_sqlite_opens_explicitly() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let _default_store = open_fact_store(&workspace).await.expect("default store");
        let _lsm_store = open_lsm_fact_store(&workspace).expect("lsm store");
        let _sqlite_store = open_sqlite_fact_store(&workspace)
            .await
            .expect("sqlite store");
        let _lsm_runtime = open_lsm_workspace(workspace.clone())
            .await
            .expect("lsm runtime");

        assert!(workspace.store_dir().join("facts.lsm/facts.wal").exists());
        assert!(workspace.facts_db_path().exists());
    }

    #[tokio::test]
    async fn db_runtime_opens_with_adapter_defaults() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let runtime = open_runtime(workspace.clone(), PoneglyphConfig::default())
            .await
            .expect("runtime");

        assert_eq!(runtime.workspace().root(), workspace.root());
        assert!(workspace.store_dir().join("facts.lsm/facts.wal").exists());
        assert!(workspace.entities_db_path().exists());
        assert!(workspace.search_db_path().exists());
    }

    #[tokio::test]
    async fn db_open_workspace_loads_workspace_config() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        let config = PoneglyphConfig::builder()
            .log_level(Some("debug".to_string()))
            .build()
            .expect("config");
        config.save_to(&workspace).await.expect("save config");

        let runtime = LocalWorkspace::from_workspace(workspace.clone())
            .open()
            .await
            .expect("runtime");

        assert_eq!(runtime.config(), &config);
        assert!(workspace.store_dir().join("facts.lsm/facts.wal").exists());
    }

    #[tokio::test]
    async fn db_repair_opens_and_repairs_workspace() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        repair_workspace(workspace.clone(), PoneglyphConfig::default())
            .await
            .expect("repair");

        assert!(workspace.store_dir().join("facts.lsm/facts.wal").exists());
    }
}
