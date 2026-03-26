use poneglyph::{Fact, Uri, Value, fact, uri};

pub(super) struct FilesystemSchema;

impl FilesystemSchema {
    pub(super) fn facts() -> Vec<Fact> {
        let mut facts = vec![
            fact!(
                uri!("filesystem:namespace"),
                uri!("schema:type"),
                Value::reference(uri!("schema:namespace"))
            ),
            fact!(
                uri!("filesystem:namespace"),
                uri!("schema:name"),
                Value::text("File System")
            ),
            fact!(
                uri!("filesystem:root"),
                uri!("schema:type"),
                Value::reference(uri!("schema:kind"))
            ),
            fact!(
                uri!("filesystem:root"),
                uri!("schema:name"),
                Value::text("Root")
            ),
            fact!(
                uri!("filesystem:file"),
                uri!("schema:type"),
                Value::reference(uri!("schema:kind"))
            ),
            fact!(
                uri!("filesystem:file"),
                uri!("schema:name"),
                Value::text("File")
            ),
        ];

        facts.extend(Self::field(
            uri!("filesystem:path"),
            "Path",
            uri!("filesystem:root"),
            true,
        ));
        facts.extend(Self::field(
            uri!("filesystem:path"),
            "Path",
            uri!("filesystem:file"),
            false,
        ));
        facts.extend(Self::field(
            uri!("filesystem:name"),
            "Name",
            uri!("filesystem:file"),
            false,
        ));
        facts.extend(Self::field(
            uri!("filesystem:sizeBytes"),
            "Size Bytes",
            uri!("filesystem:file"),
            false,
        ));
        facts.extend(Self::field(
            uri!("filesystem:modifiedAt"),
            "Modified At",
            uri!("filesystem:file"),
            false,
        ));
        facts.extend(Self::field(
            uri!("filesystem:isDir"),
            "Is Directory",
            uri!("filesystem:file"),
            false,
        ));
        facts.extend(Self::field(
            uri!("filesystem:extension"),
            "Extension",
            uri!("filesystem:file"),
            false,
        ));
        facts.extend(Self::field(
            uri!("filesystem:contentHash"),
            "Content Hash",
            uri!("filesystem:file"),
            true,
        ));
        facts.extend(Self::field(
            uri!("filesystem:became"),
            "Became",
            uri!("filesystem:file"),
            false,
        ));
        facts.extend(Self::field(
            uri!("filesystem:root"),
            "Root",
            uri!("filesystem:file"),
            false,
        ));

        facts
    }

    fn field(field_uri: Uri, name: &str, domain: Uri, identity: bool) -> Vec<Fact> {
        let mut facts = vec![
            fact!(
                field_uri.clone(),
                uri!("schema:type"),
                Value::reference(uri!("schema:field"))
            ),
            fact!(field_uri.clone(), uri!("schema:name"), Value::text(name)),
            fact!(
                field_uri.clone(),
                uri!("schema:field:domain"),
                Value::reference(domain)
            ),
        ];
        if identity {
            facts.push(fact!(
                field_uri,
                uri!("schema:field:identity"),
                Value::boolean(true)
            ));
        }
        facts
    }
}
