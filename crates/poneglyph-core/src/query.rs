use std::sync::Arc;

use datafox::{DatafoxClient, DatafoxConfig, InMemoryStorage, Query as DatafoxQuery, Substitution};
use tracing::debug;

use crate::{ActiveFact, ActiveFilter, FactService, PoneResult, Value};

/// Opaque query wrapper compiled by the current query engine implementation.
///
/// This intentionally wraps the concrete engine query type so the execution
/// engine can change later without changing the public surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query(DatafoxQuery);

impl Query {
    pub fn parse(source: &str) -> PoneResult<Self> {
        Ok(Self(datafox::parse_query(source)?))
    }

    pub fn as_inner(&self) -> &DatafoxQuery {
        &self.0
    }
}

impl std::str::FromStr for Query {
    type Err = crate::Error;

    fn from_str(source: &str) -> Result<Self, Self::Err> {
        Self::parse(source)
    }
}

impl From<DatafoxQuery> for Query {
    fn from(query: DatafoxQuery) -> Self {
        Self(query)
    }
}

/// Query results produced by the current engine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryResult(Vec<Substitution>);

impl QueryResult {
    pub fn new(substitutions: Vec<Substitution>) -> Self {
        Self(substitutions)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn substitutions(&self) -> &[Substitution] {
        &self.0
    }

    pub fn into_substitutions(self) -> Vec<Substitution> {
        self.0
    }
}

/// Query facade over the active graph exposed by [`FactService`].
#[derive(Clone)]
pub struct QueryEngine {
    facts: Arc<FactService>,
}

impl QueryEngine {
    pub fn new(facts: Arc<FactService>) -> Self {
        Self { facts }
    }

    pub async fn query(&self, query: Query) -> PoneResult<QueryResult> {
        let storage = self.active_graph_storage().await?;
        let datafox = DatafoxClient::new(DatafoxConfig::new(&storage))?;
        let results = datafox.eval(query.as_inner())?.collect::<Vec<_>>();

        debug!(result_count = results.len(), "query evaluated");
        Ok(QueryResult::new(results))
    }

    pub async fn query_str(&self, source: &str) -> PoneResult<QueryResult> {
        self.query(Query::parse(source)?).await
    }

    async fn active_graph_storage(&self) -> PoneResult<InMemoryStorage> {
        let mut active_facts = self.facts.get_active_facts(ActiveFilter::All).await?;
        let mut storage = InMemoryStorage::new();

        while let Some(active_fact) = active_facts.recv().await {
            let active_fact = active_fact?;
            for tuple in active_fact_to_tuples(active_fact.clone())? {
                storage.insert(active_fact.field.to_string(), tuple);
            }
        }

        Ok(storage)
    }
}

fn active_fact_to_tuples(fact: ActiveFact) -> PoneResult<Vec<Vec<datafox::Value>>> {
    let entity = datafox::Value::from(fact.entity.to_string());

    match fact.value {
        Value::List(values) => values
            .into_iter()
            .map(|value| Ok(vec![entity.clone(), value_to_query_value(&value)?]))
            .collect(),
        value => Ok(vec![vec![entity, value_to_query_value(&value)?]]),
    }
}

fn value_to_query_value(value: &Value) -> PoneResult<datafox::Value> {
    match value {
        Value::Null => Ok(datafox::Value::from("null")),
        Value::Text(value) => Ok(datafox::Value::from(value.clone())),
        Value::Number(value) => match value.parse::<i64>() {
            Ok(value) => Ok(datafox::Value::integer(value)),
            Err(_) => Ok(datafox::Value::from(value.clone())),
        },
        Value::Boolean(value) => Ok(datafox::Value::from(value.to_string())),
        Value::Bytes(value) => Ok(datafox::Value::from(serde_json::to_string(value)?)),
        Value::Reference(value) => Ok(datafox::Value::from(value.to_string())),
        Value::Date(value) => Ok(datafox::Value::from(value.to_string())),
        Value::DateTime(value) => Ok(datafox::Value::from(value.to_rfc3339())),
        Value::List(values) => Ok(datafox::Value::from(serde_json::to_string(values)?)),
        Value::Map(values) => Ok(datafox::Value::from(serde_json::to_string(values)?)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{Query, QueryEngine};
    use crate::{FactService, InMemoryFactStore, PoneResult, Value, fact, retraction, uri};

    fn query_engine() -> PoneResult<(Arc<FactService>, QueryEngine)> {
        let facts = Arc::new(
            FactService::builder()
                .with_store(InMemoryFactStore::new())
                .build()?,
        );
        let query_engine = QueryEngine::new(facts.clone());
        Ok((facts, query_engine))
    }

    #[tokio::test]
    async fn query_engine_parses_and_executes_single_goal_queries() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let display_name = uri!("spotify:displayName");
        let album_2112 = uri!("spotify:album:2112");

        facts
            .state_facts(vec![fact!(
                album_2112.clone(),
                display_name,
                Value::text("2112")
            )])
            .await?;

        let result = query_engine
            .query_str(r#"spotify:displayName(Album, "2112")"#)
            .await?;

        assert_eq!(result.len(), 1);
        assert_eq!(
            result.substitutions()[0].lookup("Album"),
            Some(&datafox::Value::from(album_2112.to_string()))
        );
        Ok(())
    }

    #[tokio::test]
    async fn query_engine_parses_and_executes_multi_goal_queries() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let by_artist = uri!("spotify:byArtist");
        let display_name = uri!("spotify:displayName");
        let album_2112 = uri!("spotify:album:2112");
        let artist_rush = uri!("spotify:artist:rush");

        facts
            .state_facts(vec![
                fact!(
                    album_2112.clone(),
                    by_artist,
                    Value::reference(artist_rush.clone())
                ),
                fact!(artist_rush.clone(), display_name, Value::text("Rush")),
            ])
            .await?;

        let result = query_engine
            .query(Query::parse(
                r#"spotify:byArtist(Album, Artist), spotify:displayName(Artist, "Rush")"#,
            )?)
            .await?;

        assert_eq!(result.len(), 1);
        assert_eq!(
            result.substitutions()[0].lookup("Album"),
            Some(&datafox::Value::from(album_2112.to_string()))
        );
        assert_eq!(
            result.substitutions()[0].lookup("Artist"),
            Some(&datafox::Value::from(artist_rush.to_string()))
        );
        Ok(())
    }

    #[tokio::test]
    async fn query_engine_respects_retractions_in_the_active_graph() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let display_name = uri!("spotify:displayName");
        let album_2112 = uri!("spotify:album:2112");

        facts
            .state_facts(vec![
                fact!(
                    album_2112.clone(),
                    display_name.clone(),
                    Value::text("2112")
                ),
                retraction!(album_2112, display_name, Value::text("2112")),
            ])
            .await?;

        let result = query_engine
            .query_str(r#"spotify:displayName(Album, "2112")"#)
            .await?;

        assert!(result.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn query_engine_matches_list_membership_as_multiple_relations() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let has_nicknames = uri!("dev:hasNicknames");
        let user = uri!("dev:user:leo");

        facts
            .state_facts(vec![fact!(
                user.clone(),
                has_nicknames,
                Value::list(vec![
                    Value::text("leo"),
                    Value::text("le"),
                    Value::text("leandro"),
                ])
            )])
            .await?;

        let result = query_engine
            .query_str(r#"dev:hasNicknames(User, "leo")"#)
            .await?;

        assert_eq!(result.len(), 1);
        assert_eq!(
            result.substitutions()[0].lookup("User"),
            Some(&datafox::Value::from(user.to_string()))
        );
        Ok(())
    }

    #[tokio::test]
    async fn query_engine_filters_results_with_infix_comparison_builtins() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let started_at = uri!("gcal:startedAt");
        let event_one = uri!("gcal:event:one");
        let event_two = uri!("gcal:event:two");

        facts
            .state_facts(vec![
                fact!(
                    event_one.clone(),
                    started_at.clone(),
                    Value::text("2026-01-01 22:00:00")
                ),
                fact!(event_two, started_at, Value::text("2026-01-03 08:00:00")),
            ])
            .await?;

        let result = query_engine
            .query_str(
                r#"gcal:startedAt(Event, Start), Start > "2026-01-01", Start < "2026-01-02""#,
            )
            .await?;

        assert_eq!(result.len(), 1);
        assert_eq!(
            result.substitutions()[0].lookup("Event"),
            Some(&datafox::Value::from(event_one.to_string()))
        );
        Ok(())
    }

    #[tokio::test]
    async fn query_engine_filters_results_with_named_string_builtins() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let display_name = uri!("spotify:displayName");
        let artist_rush = uri!("spotify:artist:rush");
        let artist_yes = uri!("spotify:artist:yes");

        facts
            .state_facts(vec![
                fact!(
                    artist_rush.clone(),
                    display_name.clone(),
                    Value::text("Rush")
                ),
                fact!(artist_yes, display_name, Value::text("Yes")),
            ])
            .await?;

        let result = query_engine
            .query_str(
                r#"spotify:displayName(Artist, Name), startsWith(Name, "Ru"), endsWith(Name, "sh")"#,
            )
            .await?;

        assert_eq!(result.len(), 1);
        assert_eq!(
            result.substitutions()[0].lookup("Artist"),
            Some(&datafox::Value::from(artist_rush.to_string()))
        );
        Ok(())
    }
}
