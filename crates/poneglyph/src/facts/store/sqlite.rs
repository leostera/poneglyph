use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{Row, SqlitePool};
use tokio::sync::mpsc;

use crate::facts::store::{Store, new_tx_id, validate_pending_fact};
use crate::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, Uri};

const FACTS_DB_FILE: &str = "facts.db";

#[derive(Clone)]
pub struct SqliteFactStore {
    pool: SqlitePool,
}

impl SqliteFactStore {
    pub async fn open(path: impl AsRef<Path>) -> PoneResult<Self> {
        let db_path = resolve_db_path(path.as_ref());
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| Error::FactStoreIo { source: error })?;
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

        sqlx::query("PRAGMA busy_timeout = 5000")
            .execute(&pool)
            .await?;

        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> PoneResult<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS facts (
                fact_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                entity TEXT NOT NULL,
                field TEXT NOT NULL,
                value_json TEXT NOT NULL,
                retraction INTEGER NOT NULL,
                stated_at TEXT NOT NULL,
                tx_id TEXT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS active_facts (
                tuple_key TEXT PRIMARY KEY,
                fact_id TEXT NOT NULL,
                source TEXT NOT NULL,
                entity TEXT NOT NULL,
                field TEXT NOT NULL,
                value_json TEXT NOT NULL,
                tx_id TEXT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        for statement in [
            "CREATE INDEX IF NOT EXISTS idx_facts_tx_id ON facts(tx_id)",
            "CREATE INDEX IF NOT EXISTS idx_facts_tuple ON facts(source, entity, field, value_json, stated_at DESC, fact_id DESC)",
            "CREATE INDEX IF NOT EXISTS idx_active_facts_entity ON active_facts(entity)",
            "CREATE INDEX IF NOT EXISTS idx_active_facts_field ON active_facts(field)",
            "CREATE INDEX IF NOT EXISTS idx_active_facts_field_value ON active_facts(field, value_json)",
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }

        Ok(())
    }
}

#[async_trait]
impl Store for SqliteFactStore {
    async fn state_facts(
        &self,
        mut fact_stream: mpsc::Receiver<Fact>,
    ) -> PoneResult<(Uri, Vec<Fact>)> {
        let tx_id = new_tx_id();
        let mut tx = self.pool.begin().await?;
        let mut saw_fact = false;
        let mut persisted = Vec::new();

        while let Some(mut fact) = fact_stream.recv().await {
            saw_fact = true;
            validate_pending_fact(&fact)?;

            match current_tuple_state(&mut tx, &fact).await? {
                Some(current) if fact.retraction && current.retraction => continue,
                Some(current) if fact.retraction && !current.retraction => {}
                None if fact.retraction => return Err(Error::CannotRetractUnknownFact),
                _ => {}
            }

            fact.tx_id = Some(tx_id.clone());
            insert_fact(&mut tx, &fact).await?;
            update_active_graph(&mut tx, &fact).await?;
            persisted.push(fact);
        }

        if !saw_fact {
            return Err(Error::EmptyFactBatch);
        }

        tx.commit().await?;
        Ok((tx_id, persisted))
    }

    async fn get_facts(&self, filter: Filter) -> PoneResult<mpsc::Receiver<PoneResult<Fact>>> {
        let pool = self.pool.clone();
        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            let (sql, bind_value) = match filter {
                Filter::ById(fact_id) => {
                    (fact_query_sql("WHERE f.fact_id = ?1"), fact_id.to_string())
                }
                Filter::ByTx(tx_id) => (fact_query_sql("WHERE f.tx_id = ?1"), tx_id.to_string()),
                Filter::ByEntityUri(entity_uri) => (
                    fact_query_sql("WHERE f.entity = ?1"),
                    entity_uri.to_string(),
                ),
            };

            let mut rows = sqlx::query(&sql).bind(bind_value).fetch(&pool);
            while let Some(row) = rows.next().await {
                let fact = match row {
                    Ok(row) => decode_row(row),
                    Err(error) => Err(Error::Sqlx(error)),
                };
                if tx.send(fact).await.is_err() {
                    break;
                }
            }
        });

        Ok(rx)
    }

    async fn get_active_facts(
        &self,
        filter: ActiveFilter,
    ) -> PoneResult<mpsc::Receiver<PoneResult<ActiveFact>>> {
        let pool = self.pool.clone();
        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            let (sql, binds) = active_fact_query(filter);
            let mut query = sqlx::query(&sql);
            for bind in binds {
                query = query.bind(bind);
            }

            let mut rows = query.fetch(&pool);
            while let Some(row) = rows.next().await {
                let fact = match row {
                    Ok(row) => decode_active_row(row),
                    Err(error) => Err(Error::Sqlx(error)),
                };
                if tx.send(fact).await.is_err() {
                    break;
                }
            }
        });

        Ok(rx)
    }
}

fn fact_query_sql(where_clause: &str) -> String {
    format!(
        r#"
        SELECT
            f.fact_id, f.source, f.entity, f.field, f.value_json, f.retraction, f.stated_at, f.tx_id
        FROM facts f
        {where_clause}
        ORDER BY f.stated_at DESC, f.fact_id DESC
        "#
    )
}

fn active_fact_query(filter: ActiveFilter) -> (String, Vec<String>) {
    let (where_clause, binds) = match filter {
        ActiveFilter::All => ("".to_string(), Vec::new()),
        ActiveFilter::ByEntity(entity) => {
            ("WHERE af.entity = ?1".to_string(), vec![entity.to_string()])
        }
        ActiveFilter::ByField(field) => {
            ("WHERE af.field = ?1".to_string(), vec![field.to_string()])
        }
        ActiveFilter::ByFieldValue { field, value } => (
            "WHERE af.field = ?1 AND af.value_json = ?2".to_string(),
            vec![
                field.to_string(),
                serde_json::to_string(&value).expect("serialize filter value"),
            ],
        ),
    };

    (
        format!(
            r#"
            SELECT
                af.fact_id, af.source, af.entity, af.field, af.value_json, af.tx_id
            FROM active_facts af
            {where_clause}
            ORDER BY af.entity ASC, af.field ASC, af.value_json ASC, af.fact_id ASC
            "#
        ),
        binds,
    )
}

async fn current_tuple_state(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    fact: &Fact,
) -> PoneResult<Option<Fact>> {
    let value_json = serde_json::to_string(&fact.value)?;
    let row = sqlx::query(
        r#"
        SELECT
            fact_id, source, entity, field, value_json, retraction, stated_at, tx_id
        FROM facts
        WHERE source = ?1
          AND entity = ?2
          AND field = ?3
          AND value_json = ?4
        ORDER BY stated_at DESC, fact_id DESC
        LIMIT 1
        "#,
    )
    .bind(fact.source.as_str())
    .bind(fact.entity.as_str())
    .bind(fact.field.as_str())
    .bind(value_json)
    .fetch_optional(&mut **tx)
    .await?;

    row.map(decode_row).transpose()
}

async fn insert_fact(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, fact: &Fact) -> PoneResult<()> {
    let value_json = serde_json::to_string(&fact.value)?;

    sqlx::query(
        r#"
        INSERT INTO facts (
            fact_id, source, entity, field, value_json, retraction, stated_at, tx_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
    )
    .bind(fact.fact_id.as_str())
    .bind(fact.source.as_str())
    .bind(fact.entity.as_str())
    .bind(fact.field.as_str())
    .bind(value_json)
    .bind(i64::from(fact.retraction))
    .bind(fact.stated_at)
    .bind(fact.tx_id.as_ref().expect("tx_id assigned").as_str())
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn update_active_graph(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    fact: &Fact,
) -> PoneResult<()> {
    let tuple_key = crate::facts::store::tuple_key(fact)?;
    let value_json = serde_json::to_string(&fact.value)?;

    if fact.retraction {
        sqlx::query(
            r#"
            DELETE FROM active_facts
            WHERE tuple_key = ?1
            "#,
        )
        .bind(tuple_key)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO active_facts (
                tuple_key, fact_id, source, entity, field, value_json, tx_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(tuple_key) DO UPDATE SET
                fact_id = excluded.fact_id,
                source = excluded.source,
                entity = excluded.entity,
                field = excluded.field,
                value_json = excluded.value_json,
                tx_id = excluded.tx_id
            "#,
        )
        .bind(tuple_key)
        .bind(fact.fact_id.as_str())
        .bind(fact.source.as_str())
        .bind(fact.entity.as_str())
        .bind(fact.field.as_str())
        .bind(value_json)
        .bind(fact.tx_id.as_ref().expect("tx_id assigned").as_str())
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

fn decode_row(row: SqliteRow) -> PoneResult<Fact> {
    let stated_at: DateTime<Utc> = row.try_get("stated_at")?;

    Ok(Fact {
        fact_id: Uri::parse(row.try_get::<String, _>("fact_id")?)?,
        source: Uri::parse(row.try_get::<String, _>("source")?)?,
        entity: Uri::parse(row.try_get::<String, _>("entity")?)?,
        field: Uri::parse(row.try_get::<String, _>("field")?)?,
        value: serde_json::from_str(row.try_get::<String, _>("value_json")?.as_str())?,
        retraction: row.try_get::<i64, _>("retraction")? != 0,
        stated_at,
        tx_id: Some(Uri::parse(row.try_get::<String, _>("tx_id")?)?),
    })
}

fn decode_active_row(row: SqliteRow) -> PoneResult<ActiveFact> {
    Ok(ActiveFact {
        fact_id: Uri::parse(row.try_get::<String, _>("fact_id")?)?,
        source: Uri::parse(row.try_get::<String, _>("source")?)?,
        entity: Uri::parse(row.try_get::<String, _>("entity")?)?,
        field: Uri::parse(row.try_get::<String, _>("field")?)?,
        value: serde_json::from_str(row.try_get::<String, _>("value_json")?.as_str())?,
        tx_id: Uri::parse(row.try_get::<String, _>("tx_id")?)?,
    })
}

fn resolve_db_path(path: &Path) -> PathBuf {
    if path.extension().is_some() {
        path.to_path_buf()
    } else {
        path.join(FACTS_DB_FILE)
    }
}
