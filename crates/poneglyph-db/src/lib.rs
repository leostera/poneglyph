//! Durable storage adapters for Poneglyph.
//!
//! This crate is the staging point for moving concrete database-backed
//! implementations out of `poneglyph-core`. For now it exposes adapter-opening
//! functions over the existing core SQLite implementations so downstream wiring
//! can depend on a stable storage boundary before the physical module move.

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
    Poneglyph::builder()
        .with_workspace(workspace)
        .with_config(config)
        .with_storage_factory(DbRuntimeStorageFactory)
        .build()
        .await
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
        open_entity_store, open_fact_store, open_runtime, open_search_projection, repair_workspace,
    };
    use poneglyph_core::{PoneglyphConfig, Workspace};

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
    async fn db_repair_opens_and_repairs_workspace() {
        let tempdir = tempdir().expect("tempdir");
        let workspace = Workspace::at(tempdir.path());

        repair_workspace(workspace.clone(), PoneglyphConfig::default())
            .await
            .expect("repair");

        assert!(workspace.facts_db_path().exists());
    }
}
