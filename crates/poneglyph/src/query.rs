use std::sync::Arc;

use async_trait::async_trait;
use datafox::{Evaluator, Query as DatafoxQuery, Substitution, Universe};
use tokio::sync::mpsc;

use crate::{ActiveFact, ActiveFilter, FactService, PoneResult, Uri, Value};

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
        let storage = FactServiceStorage::new(self.facts.clone());
        let universe = Universe::new(storage);
        let mut substitutions = Evaluator::evaluate(&universe, query.as_inner()).await?;
        let mut results = Vec::new();

        while let Some(substitution) = substitutions.recv().await {
            results.push(substitution?);
        }

        Ok(QueryResult::new(results))
    }

    pub async fn query_str(&self, source: &str) -> PoneResult<QueryResult> {
        self.query(Query::parse(source)?).await
    }
}

#[derive(Clone)]
struct FactServiceStorage {
    facts: Arc<FactService>,
}

impl FactServiceStorage {
    fn new(facts: Arc<FactService>) -> Self {
        Self { facts }
    }
}

#[async_trait]
impl datafox::Storage for FactServiceStorage {
    async fn get_facts_matching(
        &self,
        predicate: &str,
        pattern: Vec<Option<datafox::Value>>,
    ) -> datafox::Result<datafox::TupleStream> {
        let field = match Uri::parse(predicate.to_string()) {
            Ok(field) => field,
            Err(_) => {
                let (_tx, rx) = mpsc::channel(1);
                return Ok(rx);
            }
        };

        let mut active_facts = self
            .facts
            .get_active_facts(ActiveFilter::ByField(field))
            .await
            .map_err(datafox_store_error)?;
        let (tx, rx) = mpsc::channel(64);

        tokio::spawn(async move {
            while let Some(active_fact) = active_facts.recv().await {
                let tuple = match active_fact {
                    Ok(active_fact) => match active_fact_to_tuple(active_fact) {
                        Ok(tuple) => tuple,
                        Err(error) => {
                            if tx.send(Err(datafox_store_error(error))).await.is_err() {
                                break;
                            }
                            continue;
                        }
                    },
                    Err(error) => {
                        if tx.send(Err(datafox_store_error(error))).await.is_err() {
                            break;
                        }
                        continue;
                    }
                };

                if datafox::matches_pattern(&pattern, &tuple) && tx.send(Ok(tuple)).await.is_err() {
                    break;
                }
            }
        });

        Ok(rx)
    }
}

fn active_fact_to_tuple(fact: ActiveFact) -> PoneResult<Vec<datafox::Value>> {
    Ok(vec![
        datafox::Value::from(fact.entity.to_string()),
        value_to_query_value(&fact.value)?,
    ])
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

fn datafox_store_error(error: crate::Error) -> datafox::Error {
    datafox::Error::Parse {
        diagnostics: vec![datafox::Diagnostic::new(error.to_string())],
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::mpsc;

    use super::{Query, QueryEngine};
    use crate::{FactService, InMemoryFactStore, PoneResult, Value, fact, retraction, uri};

    fn fact_stream(facts: Vec<crate::Fact>) -> mpsc::Receiver<crate::Fact> {
        let (tx, rx) = mpsc::channel(facts.len().max(1));
        tokio::spawn(async move {
            for fact in facts {
                if tx.send(fact).await.is_err() {
                    break;
                }
            }
        });
        rx
    }

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
            .state_facts(fact_stream(vec![fact!(
                album_2112.clone(),
                display_name,
                Value::text("2112")
            )]))
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
            .state_facts(fact_stream(vec![
                fact!(
                    album_2112.clone(),
                    by_artist,
                    Value::reference(artist_rush.clone())
                ),
                fact!(artist_rush.clone(), display_name, Value::text("Rush")),
            ]))
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
            .state_facts(fact_stream(vec![
                fact!(
                    album_2112.clone(),
                    display_name.clone(),
                    Value::text("2112")
                ),
                retraction!(album_2112, display_name, Value::text("2112")),
            ]))
            .await?;

        let result = query_engine
            .query_str(r#"spotify:displayName(Album, "2112")"#)
            .await?;

        assert!(result.is_empty());
        Ok(())
    }
}
