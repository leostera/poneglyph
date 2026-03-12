use std::collections::BTreeMap;

use anyhow::Result;
use poneglyph_core::{Entity, Fact, Uri};

/// Result metadata for one consolidation pass.
#[derive(Debug, Clone, PartialEq)]
pub struct Consolidation {
    pub entity: Entity,
    pub last_processed_tx_id: Option<Uri>,
}

/// Consolidate one entity from append-only facts using newest-active-fact-wins semantics.
pub fn consolidate_entity(
    entity_uri: &Uri,
    facts: impl IntoIterator<Item = Fact>,
) -> Result<Consolidation> {
    let mut relevant = facts
        .into_iter()
        .filter(|fact| &fact.entity == entity_uri)
        .collect::<Vec<_>>();
    sort_facts(&mut relevant);

    let mut active_by_tuple = BTreeMap::<TupleKey, Fact>::new();
    for fact in &relevant {
        let key = TupleKey::from_fact(fact)?;
        active_by_tuple.entry(key).or_insert_with(|| fact.clone());
    }

    let mut current_by_field = BTreeMap::<Uri, Fact>::new();
    for fact in active_by_tuple.into_values() {
        if fact.retraction {
            continue;
        }

        match current_by_field.get(&fact.field) {
            Some(current) if fact_cmp(&fact, current).is_le() => {}
            _ => {
                current_by_field.insert(fact.field.clone(), fact);
            }
        }
    }

    let fields = current_by_field
        .into_iter()
        .map(|(field_uri, current)| (field_uri, current.value))
        .collect::<BTreeMap<_, _>>();

    let last_processed_tx_id = relevant
        .iter()
        .filter_map(|fact| fact.tx_id.as_ref())
        .max()
        .cloned();

    Ok(Consolidation {
        entity: Entity {
            uri: entity_uri.clone(),
            namespace: entity_uri.namespace().to_string(),
            kind: entity_uri.kind()?.to_string(),
            fields,
        },
        last_processed_tx_id,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct TupleKey {
    source: Uri,
    entity: Uri,
    field: Uri,
    value_json: String,
}

impl TupleKey {
    fn from_fact(fact: &Fact) -> Result<Self> {
        Ok(Self {
            source: fact.source.clone(),
            entity: fact.entity.clone(),
            field: fact.field.clone(),
            value_json: serde_json::to_string(&fact.value)?,
        })
    }
}

fn sort_facts(facts: &mut [Fact]) {
    facts.sort_by(|left, right| fact_cmp(right, left));
}

fn fact_cmp(left: &Fact, right: &Fact) -> std::cmp::Ordering {
    left.tx_id
        .cmp(&right.tx_id)
        .then_with(|| left.stated_at.cmp(&right.stated_at))
        .then_with(|| left.fact_id.cmp(&right.fact_id))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use poneglyph_core::{Fact, Uri, Value, fact, uri};

    use super::consolidate_entity;

    fn entity() -> Uri {
        uri!("spotify:album:1xndb8d9an")
    }

    fn field() -> Uri {
        uri!("spotify:displayName")
    }

    fn release_year_field() -> Uri {
        uri!("spotify:releaseYear")
    }

    fn fact(id: &str, tx: &str, field: Uri, value: Value, retraction: bool, seconds: i64) -> Fact {
        let mut fact = fact!(uri!("agent:codex:local"), entity(), field, value);
        fact.fact_id = uri!("poneglyph", "fact", id);
        fact.tx_id = Some(uri!("poneglyph", "tx", tx));
        fact.retraction = retraction;
        fact.stated_at = Utc.timestamp_opt(seconds, 0).single().expect("timestamp");
        fact
    }

    #[test]
    fn consolidates_one_entity_from_active_facts() {
        let output = consolidate_entity(
            &entity(),
            vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact(
                    "2",
                    "2",
                    release_year_field(),
                    Value::integer(1976),
                    false,
                    2,
                ),
            ],
        )
        .expect("entity");

        assert_eq!(output.entity.uri, entity());
        assert_eq!(output.entity.namespace, "spotify");
        assert_eq!(output.entity.kind, "album");
        assert_eq!(output.entity.fields.len(), 2);
    }

    #[test]
    fn newest_fact_wins_for_same_field() {
        let output = consolidate_entity(
            &entity(),
            vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact(
                    "2",
                    "2",
                    field(),
                    Value::text("2112 (Remastered)"),
                    false,
                    2,
                ),
            ],
        )
        .expect("entity");

        assert_eq!(
            output.entity.fields.get(&field()).expect("field"),
            &Value::text("2112 (Remastered)")
        );
    }

    #[test]
    fn retracted_fact_does_not_appear_in_entity() {
        let output = consolidate_entity(
            &entity(),
            vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact("2", "2", field(), Value::text("2112"), true, 2),
            ],
        )
        .expect("entity");

        assert!(!output.entity.fields.contains_key(&field()));
    }

    #[test]
    fn consolidation_is_deterministic_for_same_input() {
        let facts = vec![
            fact("1", "1", field(), Value::text("2112"), false, 1),
            fact("2", "2", field(), Value::text("2112"), true, 2),
            fact(
                "3",
                "3",
                field(),
                Value::text("2112 (Remastered)"),
                false,
                3,
            ),
        ];

        let first = consolidate_entity(&entity(), facts.clone()).expect("first");
        let second = consolidate_entity(&entity(), facts).expect("second");

        assert_eq!(first, second);
    }

    #[test]
    fn stores_last_processed_tx_id() {
        let output = consolidate_entity(
            &entity(),
            vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact(
                    "2",
                    "3",
                    field(),
                    Value::text("2112 (Remastered)"),
                    false,
                    2,
                ),
                fact(
                    "3",
                    "2",
                    release_year_field(),
                    Value::integer(1976),
                    false,
                    3,
                ),
            ],
        )
        .expect("entity");

        assert_eq!(
            output.last_processed_tx_id,
            Some(uri!("poneglyph", "tx", "3"))
        );
    }
}
