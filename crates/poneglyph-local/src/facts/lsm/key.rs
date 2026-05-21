use poneglyph::{Uri, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeyKind {
    LogTx = 0x10,
    LogFact = 0x11,
    ActiveField = 0x20,
    ActiveEntity = 0x21,
    ActiveValue = 0x22,
    Schema = 0x30,
    Meta = 0x40,
}

pub(crate) fn log_tx_key(tx_id: &Uri, seq: u64) -> Vec<u8> {
    let mut key = log_tx_prefix(tx_id);
    key.extend_from_slice(&seq.to_be_bytes());
    key
}

pub(crate) fn log_tx_prefix(tx_id: &Uri) -> Vec<u8> {
    let mut key = key_prefix(KeyKind::LogTx);
    push_str(&mut key, tx_id.as_str());
    key
}

pub(crate) fn log_fact_key(fact_id: &Uri) -> Vec<u8> {
    let mut key = key_prefix(KeyKind::LogFact);
    push_str(&mut key, fact_id.as_str());
    key
}

pub(crate) fn log_all_prefix() -> Vec<u8> {
    key_prefix(KeyKind::LogTx)
}

pub(crate) fn active_field_key(field: &Uri, entity: &Uri, value: &Value) -> Vec<u8> {
    let mut key = active_field_entity_prefix(field, entity);
    push_value(&mut key, value);
    key
}

pub(crate) fn active_field_prefix(field: &Uri) -> Vec<u8> {
    let mut key = key_prefix(KeyKind::ActiveField);
    push_str(&mut key, field.as_str());
    key
}

pub(crate) fn active_field_entity_prefix(field: &Uri, entity: &Uri) -> Vec<u8> {
    let mut key = active_field_prefix(field);
    push_str(&mut key, entity.as_str());
    key
}

pub(crate) fn active_entity_key(entity: &Uri, field: &Uri, value: &Value) -> Vec<u8> {
    let mut key = active_entity_field_prefix(entity, field);
    push_value(&mut key, value);
    key
}

pub(crate) fn active_entity_prefix(entity: &Uri) -> Vec<u8> {
    let mut key = key_prefix(KeyKind::ActiveEntity);
    push_str(&mut key, entity.as_str());
    key
}

pub(crate) fn active_entity_field_prefix(entity: &Uri, field: &Uri) -> Vec<u8> {
    let mut key = active_entity_prefix(entity);
    push_str(&mut key, field.as_str());
    key
}

pub(crate) fn active_value_key(field: &Uri, value: &Value, entity: &Uri) -> Vec<u8> {
    let mut key = active_value_prefix(field, value);
    push_str(&mut key, entity.as_str());
    key
}

pub(crate) fn active_value_prefix(field: &Uri, value: &Value) -> Vec<u8> {
    let mut key = key_prefix(KeyKind::ActiveValue);
    push_str(&mut key, field.as_str());
    push_value(&mut key, value);
    key
}

pub(crate) fn active_all_prefix() -> Vec<u8> {
    key_prefix(KeyKind::ActiveField)
}

fn key_prefix(kind: KeyKind) -> Vec<u8> {
    vec![kind as u8]
}

fn push_str(out: &mut Vec<u8>, value: &str) {
    push_bytes(out, value.as_bytes());
}

fn push_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    let len = u32::try_from(bytes.len()).expect("key component length fits u32");
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
}

fn push_value(out: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Null => out.push(0),
        Value::Text(value) => {
            out.push(1);
            push_str(out, value);
        }
        Value::Number(value) => {
            out.push(2);
            push_str(out, value);
        }
        Value::Boolean(value) => {
            out.push(3);
            out.push(u8::from(*value));
        }
        Value::Bytes(value) => {
            out.push(4);
            push_bytes(out, value);
        }
        Value::Reference(value) => {
            out.push(5);
            push_str(out, value.as_str());
        }
        Value::Date(value) => {
            out.push(6);
            push_str(out, &value.to_string());
        }
        Value::DateTime(value) => {
            out.push(7);
            push_str(out, &value.to_rfc3339());
        }
        Value::List(values) => {
            out.push(8);
            let len = u32::try_from(values.len()).expect("list length fits u32");
            out.extend_from_slice(&len.to_be_bytes());
            for value in values {
                push_value(out, value);
            }
        }
        Value::Map(values) => {
            out.push(9);
            let len = u32::try_from(values.len()).expect("map length fits u32");
            out.extend_from_slice(&len.to_be_bytes());
            for (key, value) in values {
                push_str(out, key);
                push_value(out, value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use poneglyph::{Value, uri};

    use super::{active_entity_key, active_field_key, active_value_key, log_tx_key};

    #[test]
    fn log_tx_keys_sort_by_transaction_then_sequence() {
        let tx = uri!("tx:one");
        assert!(log_tx_key(&tx, 1) < log_tx_key(&tx, 2));
        assert!(log_tx_key(&uri!("tx:one"), 9) < log_tx_key(&uri!("tx:two"), 0));
    }

    #[test]
    fn active_keys_group_by_request_prefixes() {
        let field = uri!("wiki:page:title");
        let entity = uri!("wiki:onepiece:page:luffy");
        let value = Value::text("Monkey D. Luffy");

        let by_field = active_field_key(&field, &entity, &value);
        let by_entity = active_entity_key(&entity, &field, &value);
        let by_value = active_value_key(&field, &value, &entity);

        assert!(by_field.starts_with(&[0x20]));
        assert!(by_entity.starts_with(&[0x21]));
        assert!(by_value.starts_with(&[0x22]));
        assert_ne!(by_field, by_entity);
        assert_ne!(by_field, by_value);
    }

    #[test]
    fn typed_values_do_not_collide() {
        let field = uri!("field:name");
        let entity = uri!("entity:one");
        assert_ne!(
            active_field_key(&field, &entity, &Value::text("entity:two")),
            active_field_key(&field, &entity, &Value::reference(uri!("entity:two"))),
        );
    }
}
