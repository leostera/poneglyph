use poneglyph::{Fact, Value, fact, uri};

pub(super) fn schema_facts() -> Vec<Fact> {
    let source = uri!("plex:connector:local");
    let mut facts = vec![
        fact!(
            source.clone(),
            uri!("plex:namespace"),
            uri!("schema:type"),
            Value::reference(uri!("schema:namespace"))
        ),
        fact!(
            source.clone(),
            uri!("plex:namespace"),
            uri!("schema:name"),
            Value::text("Plex")
        ),
        fact!(
            source.clone(),
            uri!("plex:namespace"),
            uri!("schema:doc"),
            Value::text("Schema entities and metadata ingested from Plex Media Server.")
        ),
        fact!(
            source.clone(),
            uri!("plex:library"),
            uri!("schema:type"),
            Value::reference(uri!("schema:kind"))
        ),
        fact!(
            source.clone(),
            uri!("plex:library"),
            uri!("schema:name"),
            Value::text("Library")
        ),
        fact!(
            source.clone(),
            uri!("plex:library"),
            uri!("schema:doc"),
            Value::text("A Plex library section such as Movies, Anime, or Series.")
        ),
    ];

    facts.extend(field_schema_facts(
        &source,
        uri!("plex:title"),
        "Title",
        "The Plex library title.",
        Some(uri!("plex:library")),
        Some("text"),
        false,
    ));
    facts.extend(field_schema_facts(
        &source,
        uri!("plex:key"),
        "Key",
        "The Plex library section key.",
        Some(uri!("plex:library")),
        Some("text"),
        true,
    ));
    facts.extend(field_schema_facts(
        &source,
        uri!("plex:libraryType"),
        "Library Type",
        "The Plex library media type, for example movie or show.",
        Some(uri!("plex:library")),
        Some("text"),
        false,
    ));
    facts.extend(field_schema_facts(
        &source,
        uri!("plex:path"),
        "Library Path",
        "A filesystem path backing the Plex library.",
        Some(uri!("plex:library")),
        Some("text"),
        false,
    ));

    facts
}

fn field_schema_facts(
    source: &poneglyph::Uri,
    field: poneglyph::Uri,
    name: &str,
    doc: &str,
    domain: Option<poneglyph::Uri>,
    value_type: Option<&str>,
    identity: bool,
) -> Vec<Fact> {
    let mut facts = vec![
        fact!(
            source.clone(),
            field.clone(),
            uri!("schema:type"),
            Value::reference(uri!("schema:field"))
        ),
        fact!(
            source.clone(),
            field.clone(),
            uri!("schema:name"),
            Value::text(name)
        ),
        fact!(
            source.clone(),
            field.clone(),
            uri!("schema:doc"),
            Value::text(doc)
        ),
    ];

    if let Some(domain) = domain {
        facts.push(fact!(
            source.clone(),
            field.clone(),
            uri!("schema:field:domain"),
            Value::reference(domain)
        ));
    }

    if let Some(value_type) = value_type {
        facts.push(fact!(
            source.clone(),
            field.clone(),
            uri!("schema:field:valueType"),
            Value::text(value_type)
        ));
    }

    if identity {
        facts.push(fact!(
            source.clone(),
            field,
            uri!("schema:field:identity"),
            Value::boolean(true)
        ));
    }

    facts
}
