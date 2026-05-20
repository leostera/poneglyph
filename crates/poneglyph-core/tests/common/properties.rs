use std::future::Future;

use proptest::prelude::*;
use proptest::test_runner::TestCaseResult;
use tokio::runtime::Builder;
use tokio::sync::mpsc;

use poneglyph_core::{Fact, Filter, PoneResult, Store, uri};

fn run_async_test<T>(f: impl Future<Output = T>) -> T {
    let runtime = Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(f)
}

fn fact_channel(facts: Vec<Fact>) -> mpsc::Receiver<Fact> {
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

async fn collect_facts(mut receiver: mpsc::Receiver<PoneResult<Fact>>) -> PoneResult<Vec<Fact>> {
    let mut facts = Vec::new();
    while let Some(fact) = receiver.recv().await {
        facts.push(fact?);
    }
    Ok(facts)
}

pub fn any_stated_facts_are_readable_immediately_after_commit<S, F, Fut>(
    make_store: F,
    facts: Vec<Fact>,
) -> TestCaseResult
where
    S: Store,
    F: Fn() -> Fut,
    Fut: Future<Output = S>,
{
    run_async_test(async move {
        let store = make_store().await;
        let assertions = facts
            .into_iter()
            .map(|fact| {
                if fact.retraction {
                    fact.asserted_copy()
                } else {
                    fact
                }
            })
            .collect::<Vec<_>>();
        let (tx_id, _committed) = store
            .state_facts(fact_channel(assertions))
            .await
            .expect("state_facts");
        let batch_facts = collect_facts(
            store
                .get_facts(Filter::ByTx(tx_id.clone()))
                .await
                .expect("batch"),
        )
        .await
        .expect("collect batch");

        prop_assert!(!batch_facts.is_empty());
        prop_assert!(
            batch_facts
                .iter()
                .all(|fact| fact.tx_id.as_ref() == Some(&tx_id))
        );

        for fact in &batch_facts {
            let stored = collect_facts(
                store
                    .get_facts(Filter::ById(fact.fact_id.clone()))
                    .await
                    .expect("by id"),
            )
            .await
            .expect("collect by id")
            .into_iter()
            .next()
            .expect("stored fact");
            prop_assert_eq!(stored.fact_id, fact.fact_id.clone());
            prop_assert_eq!(stored.value, fact.value.clone());
        }

        Ok(())
    })
}

pub fn retracting_any_prefix_hides_only_that_prefix_from_active_reads<S, F, Fut>(
    make_store: F,
    assertions: Vec<Fact>,
    retract_count: usize,
) -> TestCaseResult
where
    S: Store,
    F: Fn() -> Fut,
    Fut: Future<Output = S>,
{
    run_async_test(async move {
        let store = make_store().await;
        let assertions = assertions
            .into_iter()
            .map(|fact| {
                if fact.retraction {
                    fact.asserted_copy()
                } else {
                    fact
                }
            })
            .collect::<Vec<_>>();
        let (tx_id, _committed) = store
            .state_facts(fact_channel(assertions))
            .await
            .expect("state_facts");
        let batch_facts = collect_facts(store.get_facts(Filter::ByTx(tx_id)).await.expect("batch"))
            .await
            .expect("collect batch");

        let retract_count = retract_count.min(batch_facts.len());
        let retractions = batch_facts
            .iter()
            .take(retract_count)
            .map(|fact| {
                Fact::builder()
                    .source(fact.source.clone())
                    .entity(fact.entity.clone())
                    .field(fact.field.clone())
                    .value(fact.value.clone())
                    .retract()
                    .build()
                    .expect("retraction")
            })
            .collect::<Vec<_>>();

        if !retractions.is_empty() {
            store
                .state_facts(fact_channel(retractions))
                .await
                .expect("retractions");
        }

        for fact in batch_facts.iter().take(retract_count) {
            let refreshed = collect_facts(
                store
                    .get_facts(Filter::ById(fact.fact_id.clone()))
                    .await
                    .expect("by id"),
            )
            .await
            .expect("collect by id")
            .into_iter()
            .next()
            .expect("fact");
            prop_assert!(!refreshed.retraction);
        }

        for fact in batch_facts.iter().skip(retract_count) {
            let refreshed = collect_facts(
                store
                    .get_facts(Filter::ById(fact.fact_id.clone()))
                    .await
                    .expect("by id"),
            )
            .await
            .expect("collect by id")
            .into_iter()
            .next()
            .expect("fact");
            prop_assert!(!refreshed.retraction);
        }

        Ok(())
    })
}

trait AssertionOnly {
    fn asserted_copy(self) -> Self;
}

impl AssertionOnly for Fact {
    fn asserted_copy(mut self) -> Self {
        self.retraction = false;
        self.source = uri!("agent:prop:writer");
        self.tx_id = None;
        self
    }
}
