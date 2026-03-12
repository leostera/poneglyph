mod memory;
mod sqlite;

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use poneglyph_core::{Fact, Filter, Uri, uri};
use tokio::sync::mpsc;

pub use memory::InMemoryFactStore;
pub use sqlite::SqliteFactStore;

pub type FactReceiver = mpsc::Receiver<Result<Fact>>;

#[async_trait]
pub trait Store: Send + Sync {
    async fn state_facts(&self, fact_stream: mpsc::Receiver<Fact>) -> Result<Uri>;
    async fn get_facts(&self, filter: Filter) -> Result<FactReceiver>;
}

pub(crate) fn new_tx_id() -> Uri {
    uri!("poneglyph", "tx")
}

pub(crate) fn validate_pending_fact(fact: &Fact) -> Result<()> {
    if fact.tx_id.is_some() {
        return Err(anyhow!("pending facts cannot carry a tx_id"));
    }

    Ok(())
}

pub(crate) fn tuple_key(fact: &Fact) -> Result<String> {
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

pub(crate) fn sort_visible_facts(facts: &mut [Fact]) {
    sort_facts(facts);
}

pub(crate) fn current_fact_state<'a>(
    facts: &'a [Fact],
    candidate: &Fact,
) -> Result<Option<&'a Fact>> {
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
