use std::collections::BTreeMap;
use std::sync::Arc;

use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::{Entity, EntityStore, Error, Fact, PoneResult, Uri};

const DEFAULT_ENTITY_BROADCAST_BUFFER: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Consolidation {
    pub entity: Entity,
    pub last_processed_tx_id: Option<Uri>,
}

pub struct Consolidator {
    entity_store: Arc<dyn EntityStore>,
    fact_subscription: broadcast::Receiver<Fact>,
    entity_broadcaster: broadcast::Sender<Entity>,
}

impl Consolidator {
    pub fn builder() -> ConsolidatorBuilder {
        ConsolidatorBuilder::default()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Entity> {
        self.entity_broadcaster.subscribe()
    }

    pub async fn start(mut self) -> PoneResult<()> {
        info!("consolidator started");
        loop {
            let fact = match self.fact_subscription.recv().await {
                Ok(fact) => fact,
                Err(broadcast::error::RecvError::Closed) => {
                    info!("fact subscription closed; stopping consolidator");
                    return Ok(());
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "consolidator lagged behind fact broadcast");
                    continue;
                }
            };

            let mut facts_by_entity = BTreeMap::<Uri, Vec<Fact>>::new();
            facts_by_entity
                .entry(fact.entity.clone())
                .or_default()
                .push(fact);

            while let Ok(fact) = self.fact_subscription.try_recv() {
                facts_by_entity
                    .entry(fact.entity.clone())
                    .or_default()
                    .push(fact);
            }

            for (entity_uri, facts) in facts_by_entity {
                let fact_count = facts.len();
                debug!(%entity_uri, fact_count, "consolidating entity update batch");
                let current = self.entity_store.get_entity(&entity_uri).await?;
                let consolidation = consolidate_entity_over(current, &entity_uri, facts)?;
                if consolidation.entity.fields.is_empty() {
                    self.entity_store.delete_entity(&entity_uri).await?;
                    debug!(%entity_uri, "deleted empty entity after consolidation");
                } else {
                    let entity = consolidation.entity;
                    self.entity_store
                        .put_entity(entity.clone(), consolidation.last_processed_tx_id)
                        .await?;
                    let entity_uri = entity.uri.clone();
                    if self.entity_broadcaster.send(entity).is_err() {
                        warn!(%entity_uri, "entity updated without active projection subscribers");
                    } else {
                        debug!(%entity_uri, "broadcast consolidated entity");
                    }
                }
            }
        }
    }

    pub fn spawn(self) -> JoinHandle<PoneResult<()>> {
        tokio::spawn(async move { self.start().await })
    }
}

#[derive(Default)]
pub struct ConsolidatorBuilder {
    entity_store: Option<Arc<dyn EntityStore>>,
    fact_subscription: Option<broadcast::Receiver<Fact>>,
    entity_broadcaster: Option<broadcast::Sender<Entity>>,
}

impl ConsolidatorBuilder {
    pub fn with_entity_store<S>(self, entity_store: S) -> Self
    where
        S: EntityStore + 'static,
    {
        Self {
            entity_store: Some(Arc::new(entity_store)),
            ..self
        }
    }

    pub fn with_entity_store_arc(self, entity_store: Arc<dyn EntityStore>) -> Self {
        Self {
            entity_store: Some(entity_store),
            ..self
        }
    }

    pub fn with_fact_subscription(self, fact_subscription: broadcast::Receiver<Fact>) -> Self {
        Self {
            fact_subscription: Some(fact_subscription),
            ..self
        }
    }

    pub fn with_entity_broadcaster(self, entity_broadcaster: broadcast::Sender<Entity>) -> Self {
        Self {
            entity_broadcaster: Some(entity_broadcaster),
            ..self
        }
    }

    pub fn build(self) -> PoneResult<Consolidator> {
        Ok(Consolidator {
            entity_store: self
                .entity_store
                .ok_or(Error::MissingConsolidatorEntityStore)?,
            fact_subscription: self
                .fact_subscription
                .ok_or(Error::MissingConsolidatorFactSubscription)?,
            entity_broadcaster: self
                .entity_broadcaster
                .unwrap_or_else(new_entity_broadcaster),
        })
    }
}

fn new_entity_broadcaster() -> broadcast::Sender<Entity> {
    broadcast::channel(DEFAULT_ENTITY_BROADCAST_BUFFER).0
}

pub(crate) fn consolidate_entity_over(
    current: Option<Entity>,
    entity_uri: &Uri,
    facts: impl IntoIterator<Item = Fact>,
) -> PoneResult<Consolidation> {
    let mut relevant = facts
        .into_iter()
        .filter(|fact| &fact.entity == entity_uri)
        .collect::<Vec<_>>();
    sort_facts(&mut relevant);

    let mut entity = current.unwrap_or(Entity {
        uri: entity_uri.clone(),
        namespace: entity_uri.namespace().to_string(),
        kind: entity_uri.kind()?.to_string(),
        fields: BTreeMap::new(),
    });

    for fact in &relevant {
        if fact.retraction {
            if entity.fields.get(&fact.field) == Some(&fact.value) {
                entity.fields.remove(&fact.field);
            }
        } else {
            entity.fields.insert(fact.field.clone(), fact.value.clone());
        }
    }

    let last_processed_tx_id = relevant
        .iter()
        .filter_map(|fact| fact.tx_id.as_ref())
        .max()
        .cloned();

    debug!(
        field_count = entity.fields.len(),
        has_checkpoint = last_processed_tx_id.is_some(),
        "consolidated entity state"
    );

    Ok(Consolidation {
        entity,
        last_processed_tx_id,
    })
}

#[cfg(test)]
pub(crate) async fn consolidate_entity(
    entity_uri: &Uri,
    mut facts: tokio::sync::mpsc::Receiver<PoneResult<Fact>>,
) -> PoneResult<Consolidation> {
    let mut relevant = Vec::new();
    while let Some(fact) = facts.recv().await {
        let fact = fact?;
        if &fact.entity == entity_uri {
            relevant.push(fact);
        }
    }

    consolidate_entity_over(None, entity_uri, relevant)
}

#[cfg(test)]
pub(crate) fn consolidate_facts(
    entity_uri: &Uri,
    facts: impl IntoIterator<Item = Fact>,
) -> PoneResult<Consolidation> {
    consolidate_entity_over(None, entity_uri, facts)
}

fn sort_facts(facts: &mut [Fact]) {
    facts.sort_by(fact_cmp);
}

fn fact_cmp(left: &Fact, right: &Fact) -> std::cmp::Ordering {
    left.tx_id
        .cmp(&right.tx_id)
        .then_with(|| left.stated_at.cmp(&right.stated_at))
        .then_with(|| left.fact_id.cmp(&right.fact_id))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::{TimeZone, Utc};
    use proptest::prelude::*;
    use tokio::sync::mpsc;
    use tokio::task::yield_now;
    use tokio::time::{Duration, timeout};

    use crate::{
        Entity, EntityStore, Fact, FactService, InMemoryEntityStore, InMemoryFactStore, Uri, Value,
        fact, uri,
    };

    use super::{Consolidator, consolidate_entity, consolidate_facts};

    fn entity() -> Uri {
        uri!("spotify:album:1xndb8d9an")
    }

    fn other_entity() -> Uri {
        uri!("spotify:artist:2910301nxo")
    }

    fn field() -> Uri {
        uri!("spotify:displayName")
    }

    fn release_year_field() -> Uri {
        uri!("spotify:releaseYear")
    }

    fn fact_for(
        entity: Uri,
        id: &str,
        tx: &str,
        field: Uri,
        value: Value,
        retraction: bool,
        seconds: i64,
    ) -> Fact {
        let mut fact = fact!(uri!("agent:codex:local"), entity, field, value);
        fact.fact_id = uri!("poneglyph", "fact", id);
        fact.tx_id = Some(uri!("poneglyph", "tx", tx));
        fact.retraction = retraction;
        fact.stated_at = Utc.timestamp_opt(seconds, 0).single().expect("timestamp");
        fact
    }

    fn fact(id: &str, tx: &str, field: Uri, value: Value, retraction: bool, seconds: i64) -> Fact {
        fact_for(entity(), id, tx, field, value, retraction, seconds)
    }

    fn fact_stream(facts: Vec<Fact>) -> mpsc::Receiver<crate::PoneResult<Fact>> {
        let (tx, rx) = mpsc::channel(facts.len().max(1));
        tokio::spawn(async move {
            for fact in facts {
                if tx.send(Ok(fact)).await.is_err() {
                    break;
                }
            }
        });
        rx
    }

    async fn wait_for_entity(
        store: &impl EntityStore,
        entity_uri: &Uri,
    ) -> crate::PoneResult<Option<Entity>> {
        timeout(Duration::from_secs(1), async {
            loop {
                let entity = store.get_entity(entity_uri).await?;
                if entity.is_some() {
                    return Ok(entity);
                }
                yield_now().await;
            }
        })
        .await
        .expect("entity eventually materializes")
    }

    #[test]
    fn consolidates_one_entity_from_active_facts() {
        let output = consolidate_facts(
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
        let output = consolidate_facts(
            &entity(),
            vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact("2", "2", field(), Value::text("2112 (Deluxe)"), false, 2),
            ],
        )
        .expect("entity");

        assert_eq!(
            output.entity.fields.get(&field()),
            Some(&Value::text("2112 (Deluxe)"))
        );
    }

    #[test]
    fn retracted_fact_does_not_appear_in_entity() {
        let output = consolidate_facts(
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
            fact("2", "2", field(), Value::text("2112 (Deluxe)"), false, 2),
            fact(
                "3",
                "3",
                release_year_field(),
                Value::integer(1976),
                false,
                3,
            ),
        ];

        let left = consolidate_facts(&entity(), facts.clone()).expect("left");
        let right = consolidate_facts(&entity(), facts.into_iter().rev().collect::<Vec<_>>())
            .expect("right");

        assert_eq!(left, right);
    }

    #[test]
    fn stores_last_processed_tx_id() {
        let output = consolidate_facts(
            &entity(),
            vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact(
                    "2",
                    "3",
                    release_year_field(),
                    Value::integer(1976),
                    false,
                    2,
                ),
            ],
        )
        .expect("entity");

        assert_eq!(output.last_processed_tx_id, Some(uri!("poneglyph:tx:3")));
    }

    #[test]
    fn consolidates_multiple_entities_independently() {
        let this_entity = consolidate_facts(
            &entity(),
            vec![
                fact_for(entity(), "1", "1", field(), Value::text("2112"), false, 1),
                fact_for(
                    other_entity(),
                    "2",
                    "2",
                    field(),
                    Value::text("Rush"),
                    false,
                    2,
                ),
            ],
        )
        .expect("entity");

        let that_entity = consolidate_facts(
            &other_entity(),
            vec![
                fact_for(entity(), "1", "1", field(), Value::text("2112"), false, 1),
                fact_for(
                    other_entity(),
                    "2",
                    "2",
                    field(),
                    Value::text("Rush"),
                    false,
                    2,
                ),
            ],
        )
        .expect("entity");

        assert_eq!(
            this_entity.entity.fields.get(&field()),
            Some(&Value::text("2112"))
        );
        assert_eq!(
            that_entity.entity.fields.get(&field()),
            Some(&Value::text("Rush"))
        );
    }

    #[test]
    fn drops_entities_with_no_active_fields() {
        let output = consolidate_facts(
            &entity(),
            vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact("2", "2", field(), Value::text("2112"), true, 2),
            ],
        )
        .expect("entity");

        assert!(output.entity.fields.is_empty());
    }

    proptest! {
        #[test]
        fn property_retracting_a_value_removes_it_from_the_entity_long(
            value in any::<Value>(),
        ) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");

            runtime.block_on(async move {
                let facts = vec![
                    fact("1", "1", field(), value.clone(), false, 1),
                    fact("2", "2", field(), value, true, 2),
                ];
                let output = consolidate_entity(&entity(), fact_stream(facts))
                    .await
                    .expect("entity");

                prop_assert!(!output.entity.fields.contains_key(&field()));
                Ok::<(), proptest::test_runner::TestCaseError>(())
            })?;
        }

        #[test]
        fn property_newer_fact_wins_for_the_same_field_long(
            first in any::<Value>(),
            second in any::<Value>(),
        ) {
            let output = consolidate_facts(
                &entity(),
                vec![
                    fact("1", "1", field(), first, false, 1),
                    fact("2", "2", field(), second.clone(), false, 2),
                ],
            )
            .expect("entity");

            prop_assert_eq!(output.entity.fields.get(&field()), Some(&second));
        }

        #[test]
        fn property_consolidation_is_invariant_under_input_order_long(
            values in prop::collection::vec(any::<Value>(), 1..6),
        ) {
            let facts = values
                .into_iter()
                .enumerate()
                .map(|(index, value)| {
                    fact(
                        &(index + 1).to_string(),
                        &(index + 1).to_string(),
                        field(),
                        value,
                        false,
                        index as i64 + 1,
                    )
                })
                .collect::<Vec<_>>();

            let left = consolidate_facts(&entity(), facts.clone()).expect("left");
            let right = consolidate_facts(&entity(), facts.into_iter().rev().collect::<Vec<_>>())
                .expect("right");

            prop_assert_eq!(left, right);
        }
    }

    #[tokio::test]
    async fn consolidate_entity_consumes_fact_result_stream() {
        let output = consolidate_entity(
            &entity(),
            fact_stream(vec![
                fact("1", "1", field(), Value::text("2112"), false, 1),
                fact(
                    "2",
                    "2",
                    release_year_field(),
                    Value::integer(1976),
                    false,
                    2,
                ),
            ]),
        )
        .await
        .expect("entity");

        assert_eq!(output.entity.fields.len(), 2);
        assert_eq!(output.last_processed_tx_id, Some(uri!("poneglyph:tx:2")));
    }

    #[tokio::test]
    async fn consolidator_spawn_consumes_fact_subscription_and_persists_entities() {
        let fact_store = Arc::new(InMemoryFactStore::new());
        let fact_service = FactService::builder()
            .with_store_arc(fact_store.clone())
            .build()
            .expect("fact service");
        let entity_store = Arc::new(InMemoryEntityStore::new());
        let worker = Consolidator::builder()
            .with_entity_store_arc(entity_store.clone())
            .with_fact_subscription(fact_service.subscribe())
            .build()
            .expect("consolidator")
            .spawn();

        let entity_uri = uri!("spotify:album:2112");
        fact_service
            .state_facts(vec![fact!(
                uri!("agent:codex:local"),
                entity_uri.clone(),
                uri!("spotify:displayName"),
                Value::text("2112")
            )])
            .await
            .expect("state_facts");

        let entity = wait_for_entity(entity_store.as_ref(), &entity_uri)
            .await
            .expect("entity lookup")
            .expect("entity");
        assert_eq!(
            entity.fields.get(&uri!("spotify:displayName")),
            Some(&Value::text("2112"))
        );

        worker.abort();
    }
}
