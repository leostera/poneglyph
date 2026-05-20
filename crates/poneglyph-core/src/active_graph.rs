use std::collections::BTreeMap;

use crate::facts::store::tuple_key;
use crate::{Fact, PoneResult, Uri, Value};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub struct ActiveFact {
    pub source: Uri,
    pub entity: Uri,
    pub field: Uri,
    pub value: Value,
    pub fact_id: Uri,
    pub tx_id: Uri,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum ActiveFilter {
    All,
    ByEntity(Uri),
    ByField(Uri),
    ByFieldEntity {
        field: Uri,
        entity: Uri,
    },
    ByFieldValue {
        field: Uri,
        value: Value,
    },
    ByFieldEntityValue {
        field: Uri,
        entity: Uri,
        value: Value,
    },
}

#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct ActiveGraph {
    active_assertions: BTreeMap<String, Fact>,
    pub last_processed_tx_id: Option<Uri>,
}

impl ActiveGraph {
    pub(crate) fn apply_fact(&mut self, fact: Fact) -> PoneResult<()> {
        let key = tuple_key(&fact)?;
        if fact.retraction {
            self.active_assertions.remove(&key);
        } else {
            self.active_assertions.insert(key, fact.clone());
        }

        if let Some(tx_id) = fact.tx_id {
            self.last_processed_tx_id = Some(tx_id);
        }

        Ok(())
    }

    pub(crate) fn apply_facts(&mut self, facts: impl IntoIterator<Item = Fact>) -> PoneResult<()> {
        for fact in facts {
            self.apply_fact(fact)?;
        }
        Ok(())
    }

    pub(crate) fn active_facts_matching(&self, filter: &ActiveFilter) -> Vec<ActiveFact> {
        let mut active = self
            .active_assertions
            .values()
            .filter_map(|fact| {
                let active_fact = ActiveFact {
                    source: fact.source.clone(),
                    entity: fact.entity.clone(),
                    field: fact.field.clone(),
                    value: fact.value.clone(),
                    fact_id: fact.fact_id.clone(),
                    tx_id: fact.tx_id.clone().expect("active facts must have tx ids"),
                };

                let matches = match filter {
                    ActiveFilter::All => true,
                    ActiveFilter::ByEntity(entity) => &active_fact.entity == entity,
                    ActiveFilter::ByField(field) => &active_fact.field == field,
                    ActiveFilter::ByFieldEntity { field, entity } => {
                        &active_fact.field == field && &active_fact.entity == entity
                    }
                    ActiveFilter::ByFieldValue { field, value } => {
                        &active_fact.field == field && &active_fact.value == value
                    }
                    ActiveFilter::ByFieldEntityValue {
                        field,
                        entity,
                        value,
                    } => {
                        &active_fact.field == field
                            && &active_fact.entity == entity
                            && &active_fact.value == value
                    }
                };

                matches.then_some(active_fact)
            })
            .collect::<Vec<_>>();
        active.sort();
        active
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::{ActiveFact, ActiveFilter, ActiveGraph};
    use crate::{Fact, Value, fact, uri};

    fn timed_fact(id: &str, tx: &str, field: &str, value: Value, retraction: bool) -> Fact {
        let mut fact = fact!(
            uri!("agent:codex:local"),
            uri!("spotify:album:2112"),
            uri!(field),
            value
        );
        fact.fact_id = uri!("poneglyph", "fact", id);
        fact.tx_id = Some(uri!("poneglyph", "tx", tx));
        fact.retraction = retraction;
        fact.stated_at = Utc.with_ymd_and_hms(2026, 3, 12, 10, 0, 0).unwrap();
        fact
    }

    #[test]
    fn active_graph_keeps_active_assertions() {
        let mut graph = ActiveGraph::default();
        graph
            .apply_fact(timed_fact(
                "1",
                "1",
                "spotify:displayName",
                Value::text("2112"),
                false,
            ))
            .expect("apply fact");

        assert_eq!(
            graph.active_facts_matching(&ActiveFilter::All),
            vec![ActiveFact {
                source: uri!("agent:codex:local"),
                entity: uri!("spotify:album:2112"),
                field: uri!("spotify:displayName"),
                value: Value::text("2112"),
                fact_id: uri!("poneglyph:fact:1"),
                tx_id: uri!("poneglyph:tx:1"),
            }]
        );
        assert_eq!(graph.last_processed_tx_id, Some(uri!("poneglyph:tx:1")));
    }

    #[test]
    fn active_graph_removes_retracted_assertions() {
        let mut graph = ActiveGraph::default();
        graph
            .apply_facts(vec![
                timed_fact("1", "1", "spotify:displayName", Value::text("2112"), false),
                timed_fact("2", "2", "spotify:displayName", Value::text("2112"), true),
            ])
            .expect("apply facts");

        assert!(graph.active_facts_matching(&ActiveFilter::All).is_empty());
        assert_eq!(graph.last_processed_tx_id, Some(uri!("poneglyph:tx:2")));
    }

    #[test]
    fn active_graph_keeps_distinct_active_assertions_for_the_same_field() {
        let mut graph = ActiveGraph::default();
        graph
            .apply_facts(vec![
                timed_fact("1", "1", "spotify:displayName", Value::text("2112"), false),
                timed_fact(
                    "2",
                    "2",
                    "spotify:displayName",
                    Value::text("2112 (Deluxe)"),
                    false,
                ),
            ])
            .expect("apply facts");

        assert_eq!(
            graph.active_facts_matching(&ActiveFilter::All),
            vec![
                ActiveFact {
                    source: uri!("agent:codex:local"),
                    entity: uri!("spotify:album:2112"),
                    field: uri!("spotify:displayName"),
                    value: Value::text("2112"),
                    fact_id: uri!("poneglyph:fact:1"),
                    tx_id: uri!("poneglyph:tx:1"),
                },
                ActiveFact {
                    source: uri!("agent:codex:local"),
                    entity: uri!("spotify:album:2112"),
                    field: uri!("spotify:displayName"),
                    value: Value::text("2112 (Deluxe)"),
                    fact_id: uri!("poneglyph:fact:2"),
                    tx_id: uri!("poneglyph:tx:2"),
                },
            ]
        );
    }

    #[test]
    fn active_graph_can_filter_by_field_and_entity() {
        let mut graph = ActiveGraph::default();
        graph
            .apply_facts(vec![
                timed_fact("1", "1", "spotify:displayName", Value::text("2112"), false),
                {
                    let mut fact = timed_fact(
                        "2",
                        "2",
                        "spotify:displayName",
                        Value::text("Signals"),
                        false,
                    );
                    fact.entity = uri!("spotify:album:signals");
                    fact
                },
            ])
            .expect("apply facts");

        let facts = graph.active_facts_matching(&ActiveFilter::ByFieldEntity {
            field: uri!("spotify:displayName"),
            entity: uri!("spotify:album:signals"),
        });

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].entity, uri!("spotify:album:signals"));
        assert_eq!(facts[0].value, Value::text("Signals"));
    }

    #[test]
    fn active_graph_can_filter_by_field_entity_and_value() {
        let mut graph = ActiveGraph::default();
        graph
            .apply_facts(vec![
                timed_fact("1", "1", "spotify:displayName", Value::text("2112"), false),
                timed_fact(
                    "2",
                    "2",
                    "spotify:displayName",
                    Value::text("2112 (Deluxe)"),
                    false,
                ),
            ])
            .expect("apply facts");

        let facts = graph.active_facts_matching(&ActiveFilter::ByFieldEntityValue {
            field: uri!("spotify:displayName"),
            entity: uri!("spotify:album:2112"),
            value: Value::text("2112 (Deluxe)"),
        });

        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].value, Value::text("2112 (Deluxe)"));
    }
}
