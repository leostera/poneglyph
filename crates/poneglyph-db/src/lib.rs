//! Durable storage adapters for embedding Poneglyph in disk-backed daemons.
//!
//! Domain-specific daemons should use this crate when they want Poneglyph's
//! default workspace-backed runtime assembly. Graph semantics, facts, schemas,
//! entities, and queries remain in `poneglyph-core`; this crate supplies the
//! durable adapter boundary and repair/open helpers.
//!
//! This crate is also the staging point for moving concrete database-backed
//! implementations out of `poneglyph-core`. For now it exposes adapter-opening
//! functions over the existing core SQLite implementations so downstream wiring
//! can depend on a stable storage boundary before the physical module move.
//!
//! ```no_run
//! use poneglyph_core::{Value, Workspace, fact, uri};
//! use poneglyph_db::open_workspace;
//!
//! async fn open_codedb() -> poneglyph_core::PoneResult<()> {
//!     let workspace = Workspace::at("./codedb.poneglyph");
//!     let runtime = open_workspace(workspace).await?;
//!
//!     runtime
//!         .state_facts(vec![fact!(
//!             uri!("code:file:main-rs"),
//!             uri!("code:displayName"),
//!             Value::text("src/main.rs")
//!         )])
//!         .await?;
//!
//!     let _rows = runtime
//!         .query_str(r#"code:displayName(File, "src/main.rs")"#)
//!         .await?;
//!
//!     Ok(())
//! }
//! ```

#![allow(deprecated)]

use std::sync::Arc;

use async_trait::async_trait;
use poneglyph_core::{
    EntityStore, PoneResult, Poneglyph, PoneglyphConfig, RuntimeStorageFactory, SearchProjection,
    Store, Workspace,
};

pub use poneglyph_core::{SqliteEntityStore, SqliteFactStore};

/// Durable runtime storage factory backed by this crate's adapters.
pub struct DbRuntimeStorageFactory;

#[async_trait]
impl RuntimeStorageFactory for DbRuntimeStorageFactory {
    async fn open_fact_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
        open_fact_store(workspace).await
    }

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
        open_entity_store(workspace).await
    }

    fn open_search_projection(&self, workspace: &Workspace) -> PoneResult<Arc<SearchProjection>> {
        open_search_projection(workspace)
    }
}

/// Opens a full Poneglyph runtime using this crate's durable storage adapters.
///
/// This lets process-level crates depend on `poneglyph-db` for disk-backed
/// assembly while `poneglyph-core` retains semantic contracts and injectable
/// runtime construction.
pub async fn open_runtime(workspace: Workspace, config: PoneglyphConfig) -> PoneResult<Poneglyph> {
    runtime_builder(workspace).with_config(config).build().await
}

/// Opens a full Poneglyph runtime using durable storage and workspace config.
///
/// This is the preferred embedding helper for domain daemons that want the
/// standard disk-backed workspace layout and `config.toml` loading behavior.
pub async fn open_workspace(workspace: Workspace) -> PoneResult<Poneglyph> {
    runtime_builder(workspace).build().await
}

fn runtime_builder(workspace: Workspace) -> poneglyph_core::PoneglyphBuilder {
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_storage_factory(DbRuntimeStorageFactory)
}

/// Opens a runtime and runs storage repair for the workspace.
pub async fn repair_workspace(workspace: Workspace, config: PoneglyphConfig) -> PoneResult<()> {
    open_runtime(workspace, config).await?.repair().await
}

/// Opens the default durable fact store for a workspace.
pub async fn open_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    Ok(Arc::new(
        SqliteFactStore::open(workspace.facts_db_path()).await?,
    ))
}

/// Opens the default durable entity projection store for a workspace.
pub async fn open_entity_store(workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
    Ok(Arc::new(
        SqliteEntityStore::open(workspace.entities_db_path()).await?,
    ))
}

/// Opens the default durable search projection index for a workspace.
pub fn open_search_projection(workspace: &Workspace) -> PoneResult<Arc<SearchProjection>> {
    Ok(Arc::new(SearchProjection::open(
        workspace.search_db_path(),
    )?))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{
        DbRuntimeStorageFactory, open_entity_store, open_fact_store, open_runtime,
        open_search_projection, open_workspace, repair_workspace,
    };
    use poneglyph_core::{Poneglyph, PoneglyphConfig, Workspace};

    #[tokio::test]
    async fn db_adapters_open_workspace_backed_defaults() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());
        workspace.ensure().expect("workspace directories");

        let _fact_store = open_fact_store(&workspace).await.expect("fact store");
        let _entity_store = open_entity_store(&workspace).await.expect("entity store");
        let _search_projection = open_search_projection(&workspace).expect("search projection");

        assert!(workspace.facts_db_path().exists());
        assert!(workspace.entities_db_path().exists());
        assert!(workspace.search_db_path().exists());
    }

    #[tokio::test]
    async fn db_storage_factory_opens_runtime_adapters_through_core_builder() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let runtime = Poneglyph::builder()
            .with_workspace(workspace.clone())
            .with_config(PoneglyphConfig::default())
            .with_storage_factory(DbRuntimeStorageFactory)
            .build()
            .await
            .expect("runtime");

        assert_eq!(runtime.workspace().root(), workspace.root());
        assert!(workspace.facts_db_path().exists());
        assert!(workspace.entities_db_path().exists());
        assert!(workspace.search_db_path().exists());
    }

    #[tokio::test]
    async fn db_runtime_opens_with_adapter_defaults() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        let runtime = open_runtime(workspace.clone(), PoneglyphConfig::default())
            .await
            .expect("runtime");

        assert_eq!(runtime.workspace().root(), workspace.root());
        assert!(workspace.facts_db_path().exists());
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

        let runtime = open_workspace(workspace.clone()).await.expect("runtime");

        assert_eq!(runtime.config(), &config);
        assert!(workspace.facts_db_path().exists());
    }

    #[tokio::test]
    async fn db_repair_opens_and_repairs_workspace() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        repair_workspace(workspace.clone(), PoneglyphConfig::default())
            .await
            .expect("repair");

        assert!(workspace.facts_db_path().exists());
    }
}
