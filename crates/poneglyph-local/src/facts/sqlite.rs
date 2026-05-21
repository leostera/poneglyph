use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use tokio::sync::mpsc;
use tracing::debug;

use poneglyph::Store;
use poneglyph::facts::store::{new_tx_id, validate_pending_fact};
use poneglyph::schema::{
    PartialSchemaEntry, SCHEMA_DOC, SCHEMA_FIELD_CARDINALITY, SCHEMA_FIELD_DEPRECATED,
    SCHEMA_FIELD_DOMAIN, SCHEMA_FIELD_IDENTITY, SCHEMA_FIELD_RANGE, SCHEMA_FIELD_VALUE_TYPE,
    SCHEMA_NAME, SCHEMA_SAME_AS, SCHEMA_TYPE, SchemaDefinition, SchemaSnapshot, namespace_uri_for,
    observed_kind_uri_for,
};
use poneglyph::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, Uri, Value};

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
        sqlx::query("PRAGMA locking_mode = EXCLUSIVE")
            .execute(&pool)
            .await?;
        sqlx::query("PRAGMA wal_autocheckpoint = 0")
            .execute(&pool)
            .await?;
        sqlx::query("PRAGMA cache_size = -262144")
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

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS schema_entries (
                uri TEXT PRIMARY KEY,
                schema_type TEXT,
                name TEXT,
                doc TEXT,
                same_as TEXT,
                domain_uri TEXT,
                range_uri TEXT,
                value_type TEXT,
                cardinality TEXT,
                deprecated INTEGER,
                identity INTEGER
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        for table in ["schema_namespaces", "schema_kinds", "schema_fields"] {
            sqlx::query(&format!(
                "CREATE TABLE IF NOT EXISTS {table} (uri TEXT PRIMARY KEY)"
            ))
            .execute(&self.pool)
            .await?;
        }

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_schema_entries_type ON schema_entries(schema_type)",
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn backfill_schema_snapshot_if_needed(&self) -> PoneResult<()> {
        debug!("Starting backfill of schema...");

        let mut rows = sqlx::query(
            r#"
            SELECT
                fact_id, source, entity, field, value_json, retraction, stated_at, tx_id
            FROM facts
            ORDER BY stated_at ASC, fact_id ASC
            "#,
        )
        .fetch(&self.pool);

        let mut facts = vec![];
        while let Some(row) = rows.next().await {
            let fact = decode_row(row?)?;
            facts.push(fact);
        }

        let mut tx = self.pool.begin().await?;
        for fact in facts {
            update_schema_snapshot(&mut tx, &fact).await?;
        }
        tx.commit().await?;

        Ok(())
    }
}

#[async_trait]
impl Store for SqliteFactStore {
    async fn repair(&self) -> PoneResult<()> {
        self.backfill_schema_snapshot_if_needed().await?;
        Ok(())
    }

    async fn state_facts(
        &self,
        mut fact_stream: mpsc::Receiver<Fact>,
    ) -> PoneResult<(Uri, Vec<Fact>)> {
        let mut facts = Vec::new();
        while let Some(fact) = fact_stream.recv().await {
            facts.push(fact);
        }
        self.state_facts_vec(facts).await
    }

    async fn state_facts_vec(&self, incoming: Vec<Fact>) -> PoneResult<(Uri, Vec<Fact>)> {
        if incoming.is_empty() {
            return Err(Error::EmptyFactBatch);
        }
        for fact in &incoming {
            validate_pending_fact(fact)?;
        }

        let tx_id = new_tx_id();
        let mut tx = self.pool.begin().await?;
        let mut persisted = Vec::new();
        let mut schema_batch = SchemaBatchUpdate::default();

        if incoming.iter().all(|fact| !fact.retraction) {
            for mut fact in incoming {
                fact.tx_id = Some(tx_id.clone());
                schema_batch.observe_fact(&fact);
                persisted.push(fact);
            }
            bulk_insert_facts(&mut tx, &persisted).await?;
            bulk_upsert_active_facts(&mut tx, &persisted).await?;
        } else {
            for mut fact in incoming {
                if fact.retraction {
                    match current_tuple_state(&mut tx, &fact).await? {
                        Some(current) if current.retraction => continue,
                        Some(_) => {}
                        None => return Err(Error::CannotRetractUnknownFact),
                    }
                }

                fact.tx_id = Some(tx_id.clone());
                insert_fact(&mut tx, &fact).await?;
                update_active_graph(&mut tx, &fact).await?;
                schema_batch.observe_fact(&fact);
                persisted.push(fact);
            }
        }

        schema_batch.apply(&mut tx).await?;
        tx.commit().await?;
        Ok((tx_id, persisted))
    }

    async fn get_facts(&self, filter: Filter) -> PoneResult<mpsc::Receiver<PoneResult<Fact>>> {
        let pool = self.pool.clone();
        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            let (sql, bind_value) = match filter {
                Filter::All => (fact_query_sql(""), None),
                Filter::ById(fact_id) => (
                    fact_query_sql("WHERE f.fact_id = ?1"),
                    Some(fact_id.to_string()),
                ),
                Filter::ByTx(tx_id) => (
                    fact_query_sql("WHERE f.tx_id = ?1"),
                    Some(tx_id.to_string()),
                ),
                Filter::ByEntityUri(entity_uri) => (
                    fact_query_sql("WHERE f.entity = ?1"),
                    Some(entity_uri.to_string()),
                ),
            };

            let mut query = sqlx::query(&sql);
            if let Some(bind_value) = bind_value {
                query = query.bind(bind_value);
            }
            let mut rows = query.fetch(&pool);
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

    async fn get_schema(&self) -> PoneResult<SchemaDefinition> {
        let mut snapshot = SchemaSnapshot::default();

        let mut rows = sqlx::query(
            r#"
            SELECT
                uri, schema_type, name, doc, same_as, domain_uri, range_uri,
                value_type, cardinality, deprecated, identity
            FROM schema_entries
            ORDER BY uri ASC
            "#,
        )
        .fetch(&self.pool);

        while let Some(row) = rows.next().await {
            let row = row?;
            let uri = Uri::parse(row.try_get::<String, _>("uri")?)?;
            let entry = PartialSchemaEntry {
                schema_type: row
                    .try_get::<Option<String>, _>("schema_type")?
                    .map(Uri::parse)
                    .transpose()?,
                name: row.try_get("name")?,
                doc: row.try_get("doc")?,
                same_as: row
                    .try_get::<Option<String>, _>("same_as")?
                    .map(Uri::parse)
                    .transpose()?,
                domain: row
                    .try_get::<Option<String>, _>("domain_uri")?
                    .map(Uri::parse)
                    .transpose()?,
                range: row
                    .try_get::<Option<String>, _>("range_uri")?
                    .map(Uri::parse)
                    .transpose()?,
                value_type: row.try_get("value_type")?,
                cardinality: row.try_get("cardinality")?,
                deprecated: row
                    .try_get::<Option<i64>, _>("deprecated")?
                    .map(|value| value != 0),
                identity: row
                    .try_get::<Option<i64>, _>("identity")?
                    .map(|value| value != 0),
            };
            snapshot.insert_entry(uri, entry);
        }

        load_observed_uris(&self.pool, "schema_namespaces", |uri| {
            snapshot.observe_namespace(uri)
        })
        .await?;
        load_observed_uris(&self.pool, "schema_kinds", |uri| snapshot.observe_kind(uri)).await?;
        load_observed_uris(&self.pool, "schema_fields", |uri| {
            snapshot.observe_field(uri)
        })
        .await?;

        Ok(snapshot.into_definition())
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
        ActiveFilter::ByFieldEntity { field, entity } => (
            "WHERE af.field = ?1 AND af.entity = ?2".to_string(),
            vec![field.to_string(), entity.to_string()],
        ),
        ActiveFilter::ByFieldValue { field, value } => (
            "WHERE af.field = ?1 AND af.value_json = ?2".to_string(),
            vec![
                field.to_string(),
                serde_json::to_string(&value).expect("serialize filter value"),
            ],
        ),
        ActiveFilter::ByFieldEntityValue {
            field,
            entity,
            value,
        } => (
            "WHERE af.field = ?1 AND af.entity = ?2 AND af.value_json = ?3".to_string(),
            vec![
                field.to_string(),
                entity.to_string(),
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

async fn bulk_insert_facts(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    facts: &[Fact],
) -> PoneResult<()> {
    const CHUNK_SIZE: usize = 4_000;

    for chunk in facts.chunks(CHUNK_SIZE) {
        let mut query = QueryBuilder::<Sqlite>::new(
            r#"
            INSERT INTO facts (
                fact_id, source, entity, field, value_json, retraction, stated_at, tx_id
            )
            "#,
        );
        query.push_values(chunk, |mut row, fact| {
            row.push_bind(fact.fact_id.as_str())
                .push_bind(fact.source.as_str())
                .push_bind(fact.entity.as_str())
                .push_bind(fact.field.as_str())
                .push_bind(serde_json::to_string(&fact.value).expect("serialize fact value"))
                .push_bind(i64::from(fact.retraction))
                .push_bind(fact.stated_at)
                .push_bind(fact.tx_id.as_ref().expect("tx_id assigned").as_str());
        });
        query.build().execute(&mut **tx).await?;
    }

    Ok(())
}

async fn update_active_graph(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    fact: &Fact,
) -> PoneResult<()> {
    let tuple_key = poneglyph::facts::store::tuple_key(fact)?;
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

#[derive(Default)]
struct SchemaBatchUpdate {
    namespaces: BTreeSet<Uri>,
    kinds: BTreeSet<Uri>,
    fields: BTreeSet<Uri>,
    entries: BTreeMap<Uri, PartialSchemaEntry>,
}

impl SchemaBatchUpdate {
    fn observe_fact(&mut self, fact: &Fact) {
        if fact.retraction {
            return;
        }

        if let Some(namespace_uri) = namespace_uri_for(&fact.entity) {
            self.namespaces.insert(namespace_uri);
        }
        if let Some(namespace_uri) = namespace_uri_for(&fact.field) {
            self.namespaces.insert(namespace_uri);
        }
        if let Value::Reference(reference) = &fact.value
            && let Some(namespace_uri) = namespace_uri_for(reference)
        {
            self.namespaces.insert(namespace_uri);
        }

        self.fields.insert(fact.field.clone());

        if let Some(kind_uri) = observed_kind_uri_for(&fact.entity) {
            self.kinds.insert(kind_uri);
        }

        if fact.field.as_str() == SCHEMA_TYPE
            && let Value::Reference(kind_uri) = &fact.value
            && kind_uri.as_str() != "schema:namespace"
            && kind_uri.as_str() != "schema:kind"
            && kind_uri.as_str() != "schema:field"
        {
            self.kinds.insert(kind_uri.clone());
        }

        match (fact.field.as_str(), &fact.value) {
            (SCHEMA_TYPE, Value::Reference(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .schema_type = Some(value.clone());
            }
            (SCHEMA_NAME, Value::Text(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().name = Some(value.clone());
            }
            (SCHEMA_DOC, Value::Text(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().doc = Some(value.clone());
            }
            (SCHEMA_SAME_AS, Value::Reference(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().same_as = Some(value.clone());
            }
            (SCHEMA_FIELD_DOMAIN, Value::Reference(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().domain = Some(value.clone());
            }
            (SCHEMA_FIELD_RANGE, Value::Reference(value)) => {
                self.entries.entry(fact.entity.clone()).or_default().range = Some(value.clone());
            }
            (SCHEMA_FIELD_VALUE_TYPE, Value::Text(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .value_type = Some(value.clone());
            }
            (SCHEMA_FIELD_CARDINALITY, Value::Text(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .cardinality = Some(value.clone());
            }
            (SCHEMA_FIELD_DEPRECATED, Value::Boolean(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .deprecated = Some(*value);
            }
            (SCHEMA_FIELD_IDENTITY, Value::Boolean(value)) => {
                self.entries
                    .entry(fact.entity.clone())
                    .or_default()
                    .identity = Some(*value);
            }
            _ => {}
        }
    }

    async fn apply(self, tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>) -> PoneResult<()> {
        for uri in self.namespaces {
            insert_observed_uri(tx, "schema_namespaces", &uri).await?;
        }
        for uri in self.fields {
            insert_observed_uri(tx, "schema_fields", &uri).await?;
        }
        for uri in self.kinds {
            insert_observed_uri(tx, "schema_kinds", &uri).await?;
        }
        for (uri, entry) in self.entries {
            if let Some(value) = entry.schema_type.as_ref() {
                upsert_schema_entry_column(tx, &uri, "schema_type", Some(value.as_str())).await?;
            }
            if let Some(value) = entry.name.as_deref() {
                upsert_schema_entry_column(tx, &uri, "name", Some(value)).await?;
            }
            if let Some(value) = entry.doc.as_deref() {
                upsert_schema_entry_column(tx, &uri, "doc", Some(value)).await?;
            }
            if let Some(value) = entry.same_as.as_ref() {
                upsert_schema_entry_column(tx, &uri, "same_as", Some(value.as_str())).await?;
            }
            if let Some(value) = entry.domain.as_ref() {
                upsert_schema_entry_column(tx, &uri, "domain_uri", Some(value.as_str())).await?;
            }
            if let Some(value) = entry.range.as_ref() {
                upsert_schema_entry_column(tx, &uri, "range_uri", Some(value.as_str())).await?;
            }
            if let Some(value) = entry.value_type.as_deref() {
                upsert_schema_entry_column(tx, &uri, "value_type", Some(value)).await?;
            }
            if let Some(value) = entry.cardinality.as_deref() {
                upsert_schema_entry_column(tx, &uri, "cardinality", Some(value)).await?;
            }
            if let Some(value) = entry.deprecated {
                upsert_schema_entry_bool(tx, &uri, "deprecated", value).await?;
            }
            if let Some(value) = entry.identity {
                upsert_schema_entry_bool(tx, &uri, "identity", value).await?;
            }
        }
        Ok(())
    }
}

async fn bulk_upsert_active_facts(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    facts: &[Fact],
) -> PoneResult<()> {
    const CHUNK_SIZE: usize = 4_000;

    for chunk in facts.chunks(CHUNK_SIZE) {
        let mut query = QueryBuilder::<Sqlite>::new(
            r#"
            INSERT OR REPLACE INTO active_facts (
                tuple_key, fact_id, source, entity, field, value_json, tx_id
            )
            "#,
        );
        query.push_values(chunk, |mut row, fact| {
            row.push_bind(poneglyph::facts::store::tuple_key(fact).expect("tuple key"))
                .push_bind(fact.fact_id.as_str())
                .push_bind(fact.source.as_str())
                .push_bind(fact.entity.as_str())
                .push_bind(fact.field.as_str())
                .push_bind(serde_json::to_string(&fact.value).expect("serialize fact value"))
                .push_bind(fact.tx_id.as_ref().expect("tx_id assigned").as_str());
        });
        query.build().execute(&mut **tx).await?;
    }

    Ok(())
}

async fn update_schema_snapshot(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    fact: &Fact,
) -> PoneResult<()> {
    if fact.retraction {
        return Ok(());
    }

    if let Some(namespace_uri) = namespace_uri_for(&fact.entity) {
        insert_observed_uri(tx, "schema_namespaces", &namespace_uri).await?;
    }
    if let Some(namespace_uri) = namespace_uri_for(&fact.field) {
        insert_observed_uri(tx, "schema_namespaces", &namespace_uri).await?;
    }
    if let Value::Reference(reference) = &fact.value
        && let Some(namespace_uri) = namespace_uri_for(reference)
    {
        insert_observed_uri(tx, "schema_namespaces", &namespace_uri).await?;
    }

    insert_observed_uri(tx, "schema_fields", &fact.field).await?;

    if let Some(kind_uri) = observed_kind_uri_for(&fact.entity) {
        insert_observed_uri(tx, "schema_kinds", &kind_uri).await?;
    }

    if fact.field.as_str() == SCHEMA_TYPE
        && let Value::Reference(kind_uri) = &fact.value
        && kind_uri.as_str() != "schema:namespace"
        && kind_uri.as_str() != "schema:kind"
        && kind_uri.as_str() != "schema:field"
    {
        insert_observed_uri(tx, "schema_kinds", kind_uri).await?;
    }

    match (fact.field.as_str(), &fact.value) {
        (SCHEMA_TYPE, Value::Reference(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "schema_type", Some(value.as_str()))
                .await?;
        }
        (SCHEMA_NAME, Value::Text(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "name", Some(value.as_str())).await?;
        }
        (SCHEMA_DOC, Value::Text(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "doc", Some(value.as_str())).await?;
        }
        (SCHEMA_SAME_AS, Value::Reference(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "same_as", Some(value.as_str())).await?;
        }
        (SCHEMA_FIELD_DOMAIN, Value::Reference(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "domain_uri", Some(value.as_str()))
                .await?;
        }
        (SCHEMA_FIELD_RANGE, Value::Reference(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "range_uri", Some(value.as_str())).await?;
        }
        (SCHEMA_FIELD_VALUE_TYPE, Value::Text(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "value_type", Some(value.as_str()))
                .await?;
        }
        (SCHEMA_FIELD_CARDINALITY, Value::Text(value)) => {
            upsert_schema_entry_column(tx, &fact.entity, "cardinality", Some(value.as_str()))
                .await?;
        }
        (SCHEMA_FIELD_DEPRECATED, Value::Boolean(value)) => {
            upsert_schema_entry_bool(tx, &fact.entity, "deprecated", *value).await?;
        }
        (SCHEMA_FIELD_IDENTITY, Value::Boolean(value)) => {
            upsert_schema_entry_bool(tx, &fact.entity, "identity", *value).await?;
        }
        _ => {}
    }

    Ok(())
}

async fn insert_observed_uri(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    uri: &Uri,
) -> PoneResult<()> {
    sqlx::query(&format!("INSERT OR IGNORE INTO {table} (uri) VALUES (?1)"))
        .bind(uri.as_str())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn upsert_schema_entry_column(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    uri: &Uri,
    column: &str,
    value: Option<&str>,
) -> PoneResult<()> {
    sqlx::query(&format!(
        r#"
        INSERT INTO schema_entries (uri, {column})
        VALUES (?1, ?2)
        ON CONFLICT(uri) DO UPDATE SET {column} = excluded.{column}
        "#
    ))
    .bind(uri.as_str())
    .bind(value)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_schema_entry_bool(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    uri: &Uri,
    column: &str,
    value: bool,
) -> PoneResult<()> {
    sqlx::query(&format!(
        r#"
        INSERT INTO schema_entries (uri, {column})
        VALUES (?1, ?2)
        ON CONFLICT(uri) DO UPDATE SET {column} = excluded.{column}
        "#
    ))
    .bind(uri.as_str())
    .bind(i64::from(value))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn load_observed_uris<F>(pool: &SqlitePool, table: &str, mut observe: F) -> PoneResult<()>
where
    F: FnMut(Uri),
{
    let sql = format!("SELECT uri FROM {table} ORDER BY uri ASC");
    let mut rows = sqlx::query(&sql).fetch(pool);
    while let Some(row) = rows.next().await {
        let row = row?;
        observe(Uri::parse(row.try_get::<String, _>("uri")?)?);
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
