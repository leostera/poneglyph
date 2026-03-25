use std::path::Path;

use chrono::{DateTime, Utc};
use poneglyph::{Fact, Value, fact, uri};

pub(super) struct FilesystemFileSnapshot {
    pub(super) relative_path: String,
    pub(super) absolute_path: String,
    pub(super) is_dir: bool,
    pub(super) size_bytes: Option<u64>,
    pub(super) modified_at: Option<DateTime<Utc>>,
    pub(super) extension: Option<String>,
}

pub(super) fn root_facts(connection_id: i64, name: &str, root_path: &str) -> Vec<Fact> {
    let source = uri!("filesystem:connector:local");
    let connection_id_uri = connection_id.to_string();
    let entity = uri!("filesystem", "root", connection_id_uri.as_str());
    vec![
        fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:type"),
            Value::reference(uri!("filesystem:root"))
        ),
        fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:name"),
            Value::text(name.to_string())
        ),
        fact!(
            source,
            entity,
            uri!("filesystem:path"),
            Value::text(root_path.to_string())
        ),
    ]
}

pub(super) fn file_facts(
    connection_id: i64,
    root_path: &str,
    files: &[FilesystemFileSnapshot],
) -> Vec<Fact> {
    let source = uri!("filesystem:connector:local");
    let connection_id_uri = connection_id.to_string();
    let root_entity = uri!("filesystem", "root", connection_id_uri.as_str());
    let mut facts = Vec::with_capacity(files.len() * 8);

    for file in files {
        let entity_key = format!(
            "{}:{}",
            connection_id,
            encode_uri_part(file.relative_path.as_str())
        );
        let entity = uri!("filesystem", "file", entity_key.as_str());
        let name = Path::new(file.absolute_path.as_str())
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(file.relative_path.as_str())
            .to_string();

        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:type"),
            Value::reference(uri!("filesystem:file"))
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("schema:name"),
            Value::text(name)
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("filesystem:path"),
            Value::text(file.absolute_path.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("filesystem:root"),
            Value::reference(root_entity.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("filesystem:isDir"),
            Value::boolean(file.is_dir)
        ));

        if let Some(size_bytes) = file.size_bytes {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("filesystem:sizeBytes"),
                Value::integer(size_bytes as i64)
            ));
        }

        if let Some(modified_at) = file.modified_at {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("filesystem:modifiedAt"),
                Value::text(modified_at.to_rfc3339())
            ));
        }

        if let Some(extension) = &file.extension {
            if !extension.is_empty() {
                facts.push(fact!(
                    source.clone(),
                    entity,
                    uri!("filesystem:extension"),
                    Value::text(extension.clone())
                ));
            }
        }
    }

    if !root_path.is_empty() {
        facts.push(fact!(
            source,
            root_entity,
            uri!("filesystem:path"),
            Value::text(root_path.to_string())
        ));
    }

    facts
}

fn encode_uri_part(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/');
        if keep {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(format!("{byte:02X}").as_str());
        }
    }
    out
}
