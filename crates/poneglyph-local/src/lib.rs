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

    /// Opens a runtime after prewarming the LSM active-fact decode cache.
    pub async fn open_prewarmed(&self) -> PoneResult<Poneglyph> {
        Poneglyph::builder()
            .with_workspace(self.workspace.clone())
            .with_storage_factory(PrewarmedLsmRuntimeStorageFactory)
            .build()
            .await
    }

    /// Opens the default local fact store.
    pub async fn fact_store(&self) -> PoneResult<Arc<dyn Store>> {
        self.lsm_fact_store()
    }

    /// Opens the LSM fact store explicitly.
    pub fn lsm_fact_store(&self) -> PoneResult<Arc<dyn Store>> {
        let store = LsmFactStore::open(self.workspace.store_dir().join("facts.lsm"))?;
        if std::env::var("PONEGLYPH_LSM_PREWARM_ACTIVE_CACHE").is_ok_and(|value| value == "1") {
            store.prewarm_active_cache()?;
        }
        Ok(Arc::new(store))
    }

    /// Opens the SQLite fact store explicitly.
    pub async fn sqlite_fact_store(&self) -> PoneResult<Arc<dyn Store>> {
        Ok(Arc::new(
            SqliteFactStore::open(self.workspace.facts_db_path()).await?,
        ))
    }

    /// Opens the entity projection store.
    pub async fn entity_store(&self) -> PoneResult<Arc<dyn EntityStore>> {
        Ok(Arc::new(
            SqliteEntityStore::open(self.workspace.entities_db_path()).await?,
        ))
    }

    /// Opens the search projection.
    pub fn search_projection(&self) -> PoneResult<Arc<TantivySearchProjection>> {
        Ok(Arc::new(TantivySearchProjection::open(
            self.workspace.search_db_path(),
        )?))
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
        LocalWorkspace::from_workspace(workspace.clone())
            .fact_store()
            .await
    }

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
        LocalWorkspace::from_workspace(workspace.clone())
            .entity_store()
            .await
    }

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>> {
        LocalWorkspace::from_workspace(workspace.clone())
            .search_projection()
            .map(|projection| projection as Arc<dyn SearchProjection>)
    }
}

#[async_trait]
impl RuntimeStorageFactory for LsmRuntimeStorageFactory {
    async fn open_fact_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
        LocalWorkspace::from_workspace(workspace.clone()).lsm_fact_store()
    }

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
        LocalWorkspace::from_workspace(workspace.clone())
            .entity_store()
            .await
    }

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>> {
        LocalWorkspace::from_workspace(workspace.clone())
            .search_projection()
            .map(|projection| projection as Arc<dyn SearchProjection>)
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
        LocalWorkspace::from_workspace(workspace.clone())
            .entity_store()
            .await
    }

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>> {
        LocalWorkspace::from_workspace(workspace.clone())
            .search_projection()
            .map(|projection| projection as Arc<dyn SearchProjection>)
    }
}

/// Opens a full Poneglyph runtime using this crate's durable storage adapters.
///
/// This lets process-level crates depend on `poneglyph-local` for disk-backed
/// assembly while `poneglyph` retains semantic contracts and injectable
/// runtime construction.
#[deprecated(
    note = "use LocalWorkspace::from_workspace(workspace).open_with_config(config) instead"
)]
pub async fn open_runtime(workspace: Workspace, config: PoneglyphConfig) -> PoneResult<Poneglyph> {
    LocalWorkspace::from_workspace(workspace)
        .open_with_config(config)
        .await
}

/// Opens a full Poneglyph runtime using the LSM fact store.
#[deprecated(
    note = "LSM is the default; use LocalWorkspace::from_workspace(workspace).open_with_config(config) instead"
)]
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
#[deprecated(note = "use LocalWorkspace::from_workspace(workspace).open() instead")]
pub async fn open_workspace(workspace: Workspace) -> PoneResult<Poneglyph> {
    LocalWorkspace::from_workspace(workspace).open().await
}

/// Opens a full Poneglyph runtime with the LSM fact store and workspace config.
#[deprecated(
    note = "LSM is the default; use LocalWorkspace::from_workspace(workspace).open() instead"
)]
pub async fn open_lsm_workspace(workspace: Workspace) -> PoneResult<Poneglyph> {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_storage_factory(LsmRuntimeStorageFactory)
        .build()
        .await
}

/// Opens an LSM-backed runtime and prewarms its active-fact decode cache.
#[deprecated(
    note = "use LocalWorkspace plus PONEGLYPH_LSM_PREWARM_ACTIVE_CACHE=1 or LocalWorkspace::lsm_fact_store() instead"
)]
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
#[deprecated(note = "use LocalWorkspace::from_workspace(workspace).repair(config) instead")]
pub async fn repair_workspace(workspace: Workspace, config: PoneglyphConfig) -> PoneResult<()> {
    LocalWorkspace::from_workspace(workspace)
        .repair(config)
        .await
}

/// Opens the default durable fact store for a workspace.
#[deprecated(note = "use LocalWorkspace::from_workspace(workspace.clone()).fact_store() instead")]
pub async fn open_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    LocalWorkspace::from_workspace(workspace.clone())
        .fact_store()
        .await
}

/// Opens the SQLite fact store explicitly.
#[deprecated(
    note = "use LocalWorkspace::from_workspace(workspace.clone()).sqlite_fact_store() instead"
)]
pub async fn open_sqlite_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    LocalWorkspace::from_workspace(workspace.clone())
        .sqlite_fact_store()
        .await
}

/// Opens the custom LSM fact store for a workspace.
#[deprecated(
    note = "use LocalWorkspace::from_workspace(workspace.clone()).lsm_fact_store() instead"
)]
pub fn open_lsm_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    LocalWorkspace::from_workspace(workspace.clone()).lsm_fact_store()
}

/// Opens the default durable entity projection store for a workspace.
#[deprecated(note = "use LocalWorkspace::from_workspace(workspace.clone()).entity_store() instead")]
pub async fn open_entity_store(workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
    LocalWorkspace::from_workspace(workspace.clone())
        .entity_store()
        .await
}

/// Opens the default durable search projection index for a workspace.
#[deprecated(
    note = "use LocalWorkspace::from_workspace(workspace.clone()).search_projection() instead"
)]
pub fn open_search_projection(workspace: &Workspace) -> PoneResult<Arc<TantivySearchProjection>> {
    LocalWorkspace::from_workspace(workspace.clone()).search_projection()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{LocalRuntimeStorageFactory, LocalWorkspace};
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

        let local = LocalWorkspace::from_workspace(workspace.clone());
        let _default_store = local.fact_store().await.expect("default store");
        let _lsm_store = local.lsm_fact_store().expect("lsm store");
        let _sqlite_store = local.sqlite_fact_store().await.expect("sqlite store");
        let _runtime = local.open().await.expect("runtime");

        assert!(workspace.store_dir().join("facts.lsm/facts.wal").exists());
        assert!(workspace.facts_db_path().exists());
    }

    #[tokio::test]
    async fn db_runtime_opens_with_adapter_defaults() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let runtime = LocalWorkspace::from_workspace(workspace.clone())
            .open_with_config(PoneglyphConfig::default())
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

        LocalWorkspace::from_workspace(workspace.clone())
            .repair(PoneglyphConfig::default())
            .await
            .expect("repair");

        assert!(workspace.store_dir().join("facts.lsm/facts.wal").exists());
    }
}
