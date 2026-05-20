mod common;

use common::properties;
use poneglyph_core::{Fact, SqliteFactStore};
use proptest::prelude::*;
use tempfile::TempDir;

async fn make_store() -> (TempDir, SqliteFactStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteFactStore::open(dir.path()).await.expect("store");
    (dir, store)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    #[test]
    fn sqlite_property_any_stated_facts_are_readable_immediately_after_commit_long(
        facts in prop::collection::vec(any::<Fact>(), 1..20)
    ) {
        properties::any_stated_facts_are_readable_immediately_after_commit(
            || async {
                let (_dir, store) = make_store().await;
                store
            },
            facts,
        )?;
    }

    #[test]
    fn sqlite_property_retracting_any_prefix_hides_only_that_prefix_from_active_reads_long(
        facts in prop::collection::vec(any::<Fact>(), 1..16),
        retract_count in 0usize..16,
    ) {
        properties::retracting_any_prefix_hides_only_that_prefix_from_active_reads(
            || async {
                let (_dir, store) = make_store().await;
                store
            },
            facts,
            retract_count,
        )?;
    }
}
