use std::sync::Arc;

use crate::{
    EntityStore, PoneResult, SearchProjection, SqliteEntityStore, SqliteFactStore, Store, Workspace,
};

/// Opens the default durable fact store for a workspace.
///
/// This is the intended adapter seam for a future `poneglyph-db` crate: core
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
