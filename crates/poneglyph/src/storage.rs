use std::sync::Arc;

use async_trait::async_trait;

use crate::{
    EntityStore, InMemoryEntityStore, InMemoryFactStore, InMemorySearchProjection, PoneResult,
    SearchProjection, Store, Workspace,
};

/// Factory for opening runtime storage adapters.
///
/// `poneglyph` owns the semantic store traits. Backend crates such as
/// `poneglyph-local` provide durable implementations without making core depend
/// on a specific storage primitive.
#[async_trait]
pub trait RuntimeStorageFactory: Send + Sync {
    async fn open_fact_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn Store>>;

    async fn open_entity_store(&self, workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>>;

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>>;
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

    fn open_search_projection(
        &self,
        workspace: &Workspace,
    ) -> PoneResult<Arc<dyn SearchProjection>> {
        open_search_projection(workspace)
    }
}

/// Opens the default in-memory fact store for a core-only runtime.
pub(crate) async fn open_fact_store(_workspace: &Workspace) -> PoneResult<Arc<dyn Store>> {
    Ok(Arc::new(InMemoryFactStore::new()))
}

/// Opens the default in-memory entity store for a core-only runtime.
pub(crate) async fn open_entity_store(_workspace: &Workspace) -> PoneResult<Arc<dyn EntityStore>> {
    Ok(Arc::new(InMemoryEntityStore::new()))
}

/// Opens the default in-memory search index for a core-only runtime.
pub(crate) fn open_search_projection(
    _workspace: &Workspace,
) -> PoneResult<Arc<dyn SearchProjection>> {
    Ok(Arc::new(InMemorySearchProjection::new()))
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
        let _search_projection = open_search_projection(&workspace).expect("search index");
    }
}
