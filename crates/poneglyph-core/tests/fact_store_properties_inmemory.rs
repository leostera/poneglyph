mod common;

use common::properties;
use poneglyph_core::{Fact, InMemoryFactStore};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn inmemory_property_any_stated_facts_are_readable_immediately_after_commit_long(
        facts in prop::collection::vec(any::<Fact>(), 1..20)
    ) {
        properties::any_stated_facts_are_readable_immediately_after_commit(
            || async { InMemoryFactStore::new() },
            facts,
        )?;
    }

    #[test]
    fn inmemory_property_retracting_any_prefix_hides_only_that_prefix_from_active_reads_long(
        facts in prop::collection::vec(any::<Fact>(), 1..16),
        retract_count in 0usize..16,
    ) {
        properties::retracting_any_prefix_hides_only_that_prefix_from_active_reads(
            || async { InMemoryFactStore::new() },
            facts,
            retract_count,
        )?;
    }
}
