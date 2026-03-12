use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use poneglyph_core::{Fact, Filter, Uri};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{Row, SqlitePool};
use tokio::sync::mpsc;

use super::{FactReceiver, Store, new_tx_id, validate_pending_fact};

const FACTS_DB_FILE: &str = "facts.db";

#[derive(Clone)]
pub struct SqliteFactStore {
    pool: SqlitePool,
}

impl SqliteFactStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let db_path = resolve_db_path(path.as_ref());
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
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

    async fn migrate(&self) -> Result<()> {
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

        for statement in [
            "CREATE INDEX IF NOT EXISTS idx_facts_tx_id ON facts(tx_id)",
            "CREATE INDEX IF NOT EXISTS idx_facts_tuple ON facts(source, entity, field, value_json, stated_at DESC, fact_id DESC)",
        ] {
            sqlx::query(statement).execute(&self.pool).await?;
        }

        Ok(())
    }
}

#[async_trait]
impl Store for SqliteFactStore {
    async fn state_facts(&self, mut fact_stream: mpsc::Receiver<Fact>) -> Result<Uri> {
        let tx_id = new_tx_id();
        let mut tx = self.pool.begin().await?;
        let mut saw_fact = false;

        while let Some(mut fact) = fact_stream.recv().await {
            saw_fact = true;
            validate_pending_fact(&fact)?;

            match current_tuple_state(&mut tx, &fact).await? {
                Some(current) if fact.retraction && current.retraction => continue,
                Some(current) if fact.retraction && !current.retraction => {}
                None if fact.retraction => return Err(anyhow!("cannot retract unknown fact")),
                _ => {}
            }

            fact.tx_id = Some(tx_id.clone());
            insert_fact(&mut tx, &fact).await?;
        }

        if !saw_fact {
            return Err(anyhow!("state_facts requires at least one fact"));
        }

        tx.commit().await?;
        Ok(tx_id)
    }

    async fn get_facts(&self, filter: Filter) -> Result<FactReceiver> {
        let pool = self.pool.clone();
        let (tx, rx): (mpsc::Sender<Result<Fact>>, FactReceiver) = mpsc::channel(64);

        tokio::spawn(async move {
            let (sql, bind_value) = match filter {
                Filter::ById(fact_id) => {
                    (fact_query_sql("WHERE f.fact_id = ?1"), fact_id.to_string())
                }
                Filter::ByTx(tx_id) => (fact_query_sql("WHERE f.tx_id = ?1"), tx_id.to_string()),
            };

            let mut rows = sqlx::query(&sql).bind(bind_value).fetch(&pool);
            while let Some(row) = rows.next().await {
                let fact = match row {
                    Ok(row) => decode_row(row),
                    Err(error) => Err(anyhow::Error::from(error)),
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

async fn current_tuple_state(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    fact: &Fact,
) -> Result<Option<Fact>> {
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

async fn insert_fact(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, fact: &Fact) -> Result<()> {
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

fn decode_row(row: SqliteRow) -> Result<Fact> {
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

fn resolve_db_path(path: &Path) -> PathBuf {
    if path.extension().is_some() {
        path.to_path_buf()
    } else {
        path.join(FACTS_DB_FILE)
    }
}
