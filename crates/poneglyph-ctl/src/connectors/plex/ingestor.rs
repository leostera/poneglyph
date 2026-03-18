use std::collections::BTreeSet;

use poneglyph::{Fact, Value, fact, uri};
use serde_json::json;

use super::types::{PlexLibrarySection, PlexMetadataItem};

pub(super) fn select_sections(
    configured_libraries: &[String],
    sections: Vec<PlexLibrarySection>,
) -> Vec<PlexLibrarySection> {
    let configured: BTreeSet<&str> = configured_libraries.iter().map(String::as_str).collect();

    if configured.is_empty() {
        return sections;
    }

    sections
        .into_iter()
        .filter(|section| configured.contains(section.title.as_str()))
        .collect()
}

pub(super) fn library_facts(sections: &[PlexLibrarySection]) -> Vec<Fact> {
    let source = uri!("plex:connector:local");
    let mut facts = Vec::new();

    for section in sections {
        let entity = uri!("plex", "library", section.key.as_str());
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:type"),
            Value::reference(uri!("plex:library"))
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:name"),
            Value::text(section.title.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("plex:title"),
            Value::text(section.title.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("plex:key"),
            Value::text(section.key.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("plex:libraryType"),
            Value::text(section.section_type.clone())
        ));
        for location in &section.locations {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("plex:path"),
                Value::text(location.path.clone())
            ));
        }
    }

    facts
}

pub(super) fn item_facts(section: &PlexLibrarySection, items: &[PlexMetadataItem]) -> Vec<Fact> {
    let source = uri!("plex:connector:local");
    let library = uri!("plex", "library", section.key.as_str());
    let mut facts = Vec::new();

    for item in items {
        let entity = uri!("plex", "item", item.rating_key.as_str());
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:type"),
            Value::reference(uri!("plex:item"))
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:name"),
            Value::text(item.title.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("plex:title"),
            Value::text(item.title.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("plex:ratingKey"),
            Value::text(item.rating_key.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("plex:itemType"),
            Value::text(item.item_type.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("plex:library"),
            Value::reference(library.clone())
        ));

        if let Some(key) = &item.key {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("plex:itemKey"),
                Value::text(key.clone())
            ));
        }

        if let Some(guid) = &item.guid {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("plex:guid"),
                Value::text(guid.clone())
            ));
        }

        if let Some(summary) = &item.summary {
            if !summary.is_empty() {
                facts.push(fact!(
                    source.clone(),
                    entity.clone(),
                    uri!("plex:summary"),
                    Value::text(summary.clone())
                ));
            }
        }

        if let Some(year) = item.year {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("plex:year"),
                Value::integer(year)
            ));
        }

        if let Some(added_at) = item.added_at {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("plex:addedAt"),
                Value::integer(added_at)
            ));
        }

        if let Some(updated_at) = item.updated_at {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("plex:updatedAt"),
                Value::integer(updated_at)
            ));
        }
    }

    facts
}

pub(super) fn section_snapshot_fingerprint(
    section: &PlexLibrarySection,
    items: &[PlexMetadataItem],
) -> String {
    serde_json::to_string(&json!({
        "section": section,
        "items": items,
    }))
    .expect("valid plex snapshot fingerprint")
}

#[cfg(test)]
mod tests {
    use super::{item_facts, library_facts, section_snapshot_fingerprint, select_sections};
    use crate::connectors::plex::types::{PlexLibrarySection, PlexLocation, PlexMetadataItem};

    fn section(key: &str, title: &str, section_type: &str) -> PlexLibrarySection {
        PlexLibrarySection {
            key: key.to_string(),
            title: title.to_string(),
            section_type: section_type.to_string(),
            locations: vec![PlexLocation {
                path: format!("/media/{key}"),
            }],
        }
    }

    #[test]
    fn select_sections_filters_to_configured_titles() {
        let sections = vec![
            section("1", "Movies", "movie"),
            section("2", "Shows", "show"),
        ];

        let selected = select_sections(&["Movies".to_string()], sections);

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].title, "Movies");
    }

    #[test]
    fn library_facts_emit_title_key_type_and_path() {
        let facts = library_facts(&[section("5", "Movies", "movie")]);

        assert!(facts.iter().any(|fact| fact.field.as_str() == "plex:title"));
        assert!(facts.iter().any(|fact| fact.field.as_str() == "plex:key"));
        assert!(
            facts
                .iter()
                .any(|fact| fact.field.as_str() == "plex:libraryType")
        );
        assert!(facts.iter().any(|fact| fact.field.as_str() == "plex:path"));
    }

    #[test]
    fn item_facts_emit_item_metadata_and_library_reference() {
        let section = section("5", "Movies", "movie");
        let items = vec![PlexMetadataItem {
            rating_key: "101".to_string(),
            key: Some("/library/metadata/101".to_string()),
            guid: Some("plex://movie/abc".to_string()),
            item_type: "movie".to_string(),
            title: "Dune".to_string(),
            summary: Some("Spice.".to_string()),
            year: Some(2021),
            added_at: Some(1_710_000_000),
            updated_at: Some(1_710_000_100),
        }];

        let facts = item_facts(&section, &items);

        assert!(
            facts
                .iter()
                .any(|fact| fact.field.as_str() == "plex:ratingKey")
        );
        assert!(
            facts
                .iter()
                .any(|fact| fact.field.as_str() == "plex:itemType")
        );
        assert!(
            facts
                .iter()
                .any(|fact| fact.field.as_str() == "plex:library")
        );
        assert!(
            facts
                .iter()
                .any(|fact| fact.field.as_str() == "plex:summary")
        );
    }

    #[test]
    fn section_snapshot_fingerprint_changes_when_items_change() {
        let section = section("5", "Movies", "movie");
        let items = vec![PlexMetadataItem {
            rating_key: "101".to_string(),
            key: Some("/library/metadata/101".to_string()),
            guid: Some("plex://movie/abc".to_string()),
            item_type: "movie".to_string(),
            title: "Dune".to_string(),
            summary: Some("Spice.".to_string()),
            year: Some(2021),
            added_at: Some(1_710_000_000),
            updated_at: Some(1_710_000_100),
        }];
        let changed = vec![PlexMetadataItem {
            updated_at: Some(1_710_000_200),
            ..items[0].clone()
        }];

        let left = section_snapshot_fingerprint(&section, &items);
        let right = section_snapshot_fingerprint(&section, &changed);

        assert_ne!(left, right);
    }
}
