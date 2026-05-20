//! Durable storage adapters for Poneglyph.
//!
//! This crate is the staging point for moving concrete database-backed
//! implementations out of `poneglyph-core`. For now it exposes adapter-opening
//! functions over the existing core SQLite implementations so downstream wiring
//! can depend on a stable storage boundary before the physical module move.

use std::sync::Arc;

use poneglyph_core::{
    EntityStore, FactService, PoneResult, Poneglyph, PoneglyphConfig, SearchProjection,
    SqliteEntityStore, SqliteFactStore, Store, Workspace,
};

/// Opens a full Poneglyph runtime using this crate's durable storage adapters.
///
/// This lets process-level crates depend on `poneglyph-db` for disk-backed
/// assembly while `poneglyph-core` retains semantic contracts and injectable
/// runtime construction.
pub async fn open_runtime(workspace: Workspace, config: PoneglyphConfig) -> PoneResult<Poneglyph> {
    let fact_store = open_fact_store(&workspace).await?;
    let fact_service = Arc::new(FactService::builder().with_store_arc(fact_store).build()?);
    let entity_store = open_entity_store(&workspace).await?;
    let search_projection = open_search_projection(&workspace)?;

    Poneglyph::builder()
        .with_workspace(workspace)
        .with_config(config)
        .with_fact_service_arc(fact_service)
        .with_entity_store_arc(entity_store)
        .with_search_projection_arc(search_projection)
        .build()
        .await
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

    use super::{open_entity_store, open_fact_store, open_runtime, open_search_projection};
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
}
