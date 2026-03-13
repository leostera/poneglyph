use std::sync::Arc;

use datafrog::{Iteration, Relation};

use crate::{ActiveFact, ActiveFilter, FactService, PoneResult, Uri, Value};

/// One exact field/value constraint in a query.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Clause {
    pub field: Uri,
    pub value: Value,
}

impl Clause {
    pub fn new(field: Uri, value: Value) -> Self {
        Self { field, value }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum QueryPlan {
    MatchEntities { clauses: Vec<Clause> },
    ReachableFrom { field: Uri, source: Uri },
}

/// Opaque query wrapper compiled by the current query engine implementation.
///
/// This intentionally wraps a private internal plan rather than exposing
/// `datafrog` types directly so the execution engine can change later.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query(QueryPlan);

impl Query {
    pub fn match_entities(clauses: impl IntoIterator<Item = Clause>) -> Self {
        Self(QueryPlan::MatchEntities {
            clauses: clauses.into_iter().collect(),
        })
    }

    pub fn reachable_from(field: Uri, source: Uri) -> Self {
        Self(QueryPlan::ReachableFrom { field, source })
    }
}

/// Query results produced by the current engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryResult {
    Entities(Vec<Uri>),
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
        match query.0 {
            QueryPlan::MatchEntities { clauses } => self
                .match_entities(clauses)
                .await
                .map(QueryResult::Entities),
            QueryPlan::ReachableFrom { field, source } => self
                .reachable_from(field, source)
                .await
                .map(QueryResult::Entities),
        }
    }

    async fn match_entities(&self, clauses: Vec<Clause>) -> PoneResult<Vec<Uri>> {
        if clauses.is_empty() {
            return Ok(Vec::new());
        }

        let mut entity_sets = Vec::with_capacity(clauses.len());
        for clause in clauses {
            let active_facts = collect_active_facts(
                &self.facts,
                ActiveFilter::ByFieldValue {
                    field: clause.field,
                    value: clause.value,
                },
            )
            .await?;

            entity_sets.push(Relation::from_iter(
                active_facts.into_iter().map(|fact| (fact.entity, ())),
            ));
        }

        let mut matches = entity_sets.remove(0);
        for entity_set in entity_sets {
            matches =
                Relation::from_join(&matches, &entity_set, |entity, _, _| (entity.clone(), ()));
        }

        Ok(matches
            .elements
            .into_iter()
            .map(|(entity, ())| entity)
            .collect())
    }

    async fn reachable_from(&self, field: Uri, source: Uri) -> PoneResult<Vec<Uri>> {
        let active_facts = collect_active_facts(&self.facts, ActiveFilter::ByField(field)).await?;
        let edges = active_reference_edges(active_facts);

        let mut iteration = Iteration::new();
        let reachable = iteration.variable::<(Uri, Uri)>("reachable");
        let reachable_by_intermediate =
            iteration.variable::<(Uri, Uri)>("reachable_by_intermediate");

        reachable.insert(edges.clone());

        while iteration.changed() {
            reachable_by_intermediate.from_map(&reachable, |(ancestor, descendant)| {
                (descendant.clone(), ancestor.clone())
            });
            reachable.from_join(
                &reachable_by_intermediate,
                &edges,
                |_, ancestor, descendant| (ancestor.clone(), descendant.clone()),
            );
        }

        let reachable = reachable.complete();
        let matches = Relation::from_map(&reachable, |(ancestor, descendant)| {
            if ancestor == &source {
                Some(descendant.clone())
            } else {
                None
            }
        });

        Ok(matches.elements.into_iter().flatten().collect())
    }
}

async fn collect_active_facts(
    facts: &FactService,
    filter: ActiveFilter,
) -> PoneResult<Vec<ActiveFact>> {
    let mut rx = facts.get_active_facts(filter).await?;
    let mut active_facts = Vec::new();

    while let Some(fact) = rx.recv().await {
        active_facts.push(fact?);
    }

    Ok(active_facts)
}

fn active_reference_edges(active_facts: Vec<ActiveFact>) -> Relation<(Uri, Uri)> {
    Relation::from_iter(
        active_facts
            .into_iter()
            .filter_map(|fact| match fact.value {
                Value::Reference(target) => Some((fact.entity, target)),
                _ => None,
            }),
    )
}

#[cfg(test)]
mod tests {
    use super::{Clause, Query, QueryEngine, QueryResult};
    use crate::{FactService, InMemoryFactStore, PoneResult, Value, fact, retraction, uri};

    use std::sync::Arc;
    use tokio::sync::mpsc;

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
    async fn query_engine_matches_entities_from_active_graph() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let display_name = uri!("spotify:displayName");
        let by_artist = uri!("spotify:byArtist");
        let album_2112 = uri!("spotify:album:2112");
        let album_signals = uri!("spotify:album:signals");

        facts
            .state_facts(fact_stream(vec![
                fact!(
                    album_2112.clone(),
                    display_name.clone(),
                    Value::text("2112")
                ),
                fact!(album_2112.clone(), by_artist.clone(), Value::text("Rush")),
                fact!(album_signals.clone(), display_name, Value::text("Signals")),
                fact!(album_signals.clone(), by_artist, Value::text("Rush")),
            ]))
            .await?;

        let result = query_engine
            .query(Query::match_entities([
                Clause::new(uri!("spotify:displayName"), Value::text("2112")),
                Clause::new(uri!("spotify:byArtist"), Value::text("Rush")),
            ]))
            .await?;

        assert_eq!(result, QueryResult::Entities(vec![album_2112]));
        Ok(())
    }

    #[tokio::test]
    async fn query_engine_reaches_entities_over_reference_edges() -> PoneResult<()> {
        let (facts, query_engine) = query_engine()?;
        let master_of = uri!("jedi:masterOf");
        let quigon = uri!("jedi:quigon");
        let obiwan = uri!("jedi:obiwan");
        let anakin = uri!("jedi:anakin");
        let ahsoka = uri!("jedi:ahsoka");

        facts
            .state_facts(fact_stream(vec![
                fact!(
                    quigon.clone(),
                    master_of.clone(),
                    Value::reference(obiwan.clone())
                ),
                fact!(
                    obiwan.clone(),
                    master_of.clone(),
                    Value::reference(anakin.clone())
                ),
                fact!(
                    anakin.clone(),
                    master_of.clone(),
                    Value::reference(ahsoka.clone())
                ),
            ]))
            .await?;

        let result = query_engine
            .query(Query::reachable_from(master_of, quigon))
            .await?;

        assert_eq!(result, QueryResult::Entities(vec![ahsoka, anakin, obiwan]));
        Ok(())
    }

    #[tokio::test]
    async fn query_engine_excludes_retracted_facts_from_matches() -> PoneResult<()> {
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
            .query(Query::match_entities([Clause::new(
                uri!("spotify:displayName"),
                Value::text("2112"),
            )]))
            .await?;

        assert_eq!(result, QueryResult::Entities(vec![]));
        Ok(())
    }
}
