use std::path::{Path, PathBuf};

use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::entities::store::EntityStore;
use crate::{Entity, Error, PoneResult, Uri};

const ENTITIES_DB_FILE: &str = "entities.db";

#[derive(Clone)]
pub struct SqliteEntityStore {
    pool: SqlitePool,
}

impl SqliteEntityStore {
    pub async fn open(path: impl AsRef<Path>) -> PoneResult<Self> {
        let db_path = resolve_db_path(path.as_ref());
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| Error::EntityStoreIo { source: error })?;
        }

        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;

        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> PoneResult<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS entities (
                uri TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                kind TEXT NOT NULL,
                fields_json TEXT NOT NULL,
                last_processed_tx_id TEXT
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }
}

#[async_trait]
impl EntityStore for SqliteEntityStore {
    async fn put_entity(
        &self,
        entity: Entity,
        last_processed_tx_id: Option<Uri>,
    ) -> PoneResult<()> {
        sqlx::query(
            r#"
            INSERT INTO entities (uri, namespace, kind, fields_json, last_processed_tx_id)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(uri) DO UPDATE SET
                namespace = excluded.namespace,
                kind = excluded.kind,
                fields_json = excluded.fields_json,
                last_processed_tx_id = excluded.last_processed_tx_id
            "#,
        )
        .bind(entity.uri.as_str())
        .bind(&entity.namespace)
        .bind(&entity.kind)
        .bind(serde_json::to_string(&entity.fields)?)
        .bind(last_processed_tx_id.as_ref().map(Uri::to_string))
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn delete_entity(&self, entity_uri: &Uri) -> PoneResult<()> {
        sqlx::query("DELETE FROM entities WHERE uri = ?1")
            .bind(entity_uri.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn get_entity(&self, entity_uri: &Uri) -> PoneResult<Option<Entity>> {
        let row = sqlx::query(
            r#"
            SELECT uri, namespace, kind, fields_json
            FROM entities
            WHERE uri = ?1
            "#,
        )
        .bind(entity_uri.as_str())
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            Ok(Entity {
                uri: Uri::parse(row.try_get::<String, _>("uri")?)?,
                namespace: row.try_get("namespace")?,
                kind: row.try_get("kind")?,
                fields: serde_json::from_str(row.try_get::<String, _>("fields_json")?.as_str())?,
            })
        })
        .transpose()
    }
}

fn resolve_db_path(path: &Path) -> PathBuf {
    if path.extension().is_some() {
        path.to_path_buf()
    } else {
        path.join(ENTITIES_DB_FILE)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tempfile::tempdir;

    use crate::entities::store::{EntityStore, SqliteEntityStore};
    use crate::{Entity, Value, uri};

    #[tokio::test]
    async fn sqlite_entity_store_put_get_delete_roundtrip() {
        let dir = tempdir().expect("tempdir");
        let store = SqliteEntityStore::open(dir.path())
            .await
            .expect("sqlite entity store");
        let entity = Entity {
            uri: uri!("spotify:album:snakes-and-arrows"),
            namespace: "spotify".to_string(),
            kind: "album".to_string(),
            fields: BTreeMap::from([(uri!("spotify:displayName"), Value::text("Snakes & Arrows"))]),
        };

        store
            .put_entity(entity.clone(), Some(uri!("poneglyph:tx:1")))
            .await
            .expect("put_entity");

        let stored = store
            .get_entity(&entity.uri)
            .await
            .expect("get_entity")
            .expect("entity");
        assert_eq!(stored, entity);

        store
            .delete_entity(&entity.uri)
            .await
            .expect("delete_entity");

        let deleted = store.get_entity(&entity.uri).await.expect("get_entity");
        assert_eq!(deleted, None);
    }
}
