use crate::context::AppContext;
use poneglyph_ctl::SaveFilesystemConnection;

#[derive(Debug, Clone)]
pub(crate) struct FilesystemConnection {
    pub id: i64,
    pub name: String,
    pub root_path: String,
}

pub(crate) struct FilesystemService<'a> {
    context: &'a AppContext,
}

impl<'a> FilesystemService<'a> {
    pub(crate) fn new(context: &'a AppContext) -> Self {
        Self { context }
    }

    pub(crate) async fn list_connections(
        &self,
    ) -> std::result::Result<Vec<FilesystemConnection>, String> {
        self.context
            .ctl
            .list_filesystem_connections()
            .await
            .map(|connections| {
                connections
                    .into_iter()
                    .map(|connection| FilesystemConnection {
                        id: connection.id,
                        name: connection.name,
                        root_path: connection.root_path,
                    })
                    .collect()
            })
            .map_err(|error| format!("failed to list filesystem connections: {error}"))
    }

    pub(crate) async fn save_connection(
        &self,
        name: String,
        root_path: String,
    ) -> std::result::Result<FilesystemConnection, String> {
        self.context
            .ctl
            .save_filesystem_connection(SaveFilesystemConnection { name, root_path })
            .await
            .map(|connection| FilesystemConnection {
                id: connection.id,
                name: connection.name,
                root_path: connection.root_path,
            })
            .map_err(|error| format!("failed to save filesystem connection: {error}"))
    }

    pub(crate) async fn delete_connection(
        &self,
        connection_id: i64,
    ) -> std::result::Result<bool, String> {
        self.context
            .ctl
            .delete_filesystem_connection(connection_id)
            .await
            .map_err(|error| format!("failed to delete filesystem connection: {error}"))
    }
}
