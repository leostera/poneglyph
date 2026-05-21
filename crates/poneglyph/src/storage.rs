use std::sync::Arc;

use async_trait::async_trait;

use crate::{
    EntityStore, PoneResult, SearchProjection, SqliteEntityStore, SqliteFactStore, Store, Workspace,
};

/// Factory for opening runtime storage adapters.
///
/// `poneglyph` owns the semantic store traits. Process-level crates can
/// provide a factory from `poneglyph-local` so disk-backed runtime construction can
/// move out of core without making core depend on db.
#[async_trait]
pub trait RuntimeStorageFactory: Send + Sync {
    async fn open_fact_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn Store>>;

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>>;

    fn open_search_projection(&self, workspace: &Workspace) -> PoneResult<Arc<SearchProjection>>;
}

pub(crate) struct DefaultRuntimeStorageFactory;

#[async_trait]
impl RuntimeStorageFactory for DefaultRuntimeStorageFactory {
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

/// Opens the default durable fact store for a workspace.
///
/// This is the intended adapter seam for a future `poneglyph-local` crate: core
/// owns the semantic `Store` trait, while concrete disk-backed adapters should
/// eventually move behind this boundary.
pub(crate) async fn open_fact_store(workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    Ok(Arc::new(
        SqliteFactStore::open(workspace.facts_db_path()).await?,
    ))
}

/// Opens the default durable entity store for a workspace.
///
/// Entity storage is a replayable projection, but it still uses a concrete disk
/// adapter today. Keep runtime assembly pointed at this seam instead of directly
/// constructing SQLite stores in `runtime.rs`.
pub(crate) async fn open_entity_store(workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
    Ok(Arc::new(
        SqliteEntityStore::open(workspace.entities_db_path()).await?,
    ))
}

/// Opens the default search projection index for a workspace.
pub(crate) fn open_search_projection(workspace: &Workspace) -> PoneResult<Arc<SearchProjection>> {
    Ok(Arc::new(SearchProjection::open(
        workspace.search_db_path(),
    )?))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{open_entity_store, open_fact_store, open_search_projection};
    use crate::Workspace;

    #[tokio::test]
    async fn storage_adapters_open_workspace_backed_defaults() {
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
}
