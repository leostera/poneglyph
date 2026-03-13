mod memory;
mod sqlite;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::{ActiveFact, ActiveFilter, Error, Fact, Filter, PoneResult, Uri, uri};

pub use memory::InMemoryFactStore;
pub use sqlite::SqliteFactStore;

#[async_trait]
pub trait Store: Send + Sync {
    async fn state_facts(&self, fact_stream: mpsc::Receiver<Fact>) -> PoneResult<(Uri, Vec<Fact>)>;
    async fn get_facts(&self, filter: Filter) -> PoneResult<mpsc::Receiver<PoneResult<Fact>>>;
    async fn get_active_facts(
        &self,
        filter: ActiveFilter,
    ) -> PoneResult<mpsc::Receiver<PoneResult<ActiveFact>>>;
}

pub(crate) fn new_tx_id() -> Uri {
    uri!("poneglyph", "tx")
}

pub(crate) fn validate_pending_fact(fact: &Fact) -> PoneResult<()> {
    if fact.tx_id.is_some() {
        return Err(Error::PendingFactHasTxId);
    }

    Ok(())
}

pub(crate) fn tuple_key(fact: &Fact) -> PoneResult<String> {
    Ok(format!(
        "{}|{}|{}|{}",
        fact.source.as_str(),
        fact.entity.as_str(),
        fact.field.as_str(),
        serde_json::to_string(&fact.value)?,
    ))
}

pub(crate) fn sort_facts(facts: &mut [Fact]) {
    facts.sort_by(|left, right| {
        right
            .stated_at
            .cmp(&left.stated_at)
            .then_with(|| right.fact_id.as_str().cmp(left.fact_id.as_str()))
    });
}

pub(crate) fn current_fact_state<'a>(
    facts: &'a [Fact],
    candidate: &Fact,
) -> PoneResult<Option<&'a Fact>> {
    let key = tuple_key(candidate)?;
    let mut ordered = facts.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        right
            .stated_at
            .cmp(&left.stated_at)
            .then_with(|| right.fact_id.as_str().cmp(left.fact_id.as_str()))
    });
    Ok(ordered
        .into_iter()
        .find(|fact| tuple_key(fact).ok().as_ref() == Some(&key)))
}
