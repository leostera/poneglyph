use std::collections::BTreeSet;

use poneglyph::{Fact, Value, fact, uri};

use super::types::PlexLibrarySection;

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

#[cfg(test)]
mod tests {
    use super::{library_facts, select_sections};
    use crate::connectors::plex::types::{PlexLibrarySection, PlexLocation};

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
}
