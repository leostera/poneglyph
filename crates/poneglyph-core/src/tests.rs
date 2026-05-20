#[cfg(test)]
mod tests {
    use crate::{Fact, Uri, Value, fact, retraction, uri};

    #[test]
    fn uri_from_parts_uses_namespace_kind_and_given_id() {
        let uri = Uri::from_parts("spotify", "album", Some("2112")).expect("uri");
        assert_eq!(uri.as_str(), "spotify:album:2112");
    }

    #[test]
    fn uri_from_parts_generates_an_id_when_missing() {
        let uri = Uri::from_parts("spotify", "album", None).expect("uri");
        assert!(uri.as_str().starts_with("spotify:album:"));
    }

    #[test]
    fn uri_macro_parses_literal_values() {
        let uri = uri!("spotify:album:2112");
        assert_eq!(uri.as_str(), "spotify:album:2112");
    }

    #[test]
    fn uri_macro_generates_random_id_from_two_parts() {
        let uri = uri!("spotify", "album");
        assert!(uri.as_str().starts_with("spotify:album:"));
    }

    #[test]
    fn uri_macro_builds_uri_from_three_parts() {
        let uri = uri!("spotify", "album", "2112");
        assert_eq!(uri.as_str(), "spotify:album:2112");
    }

    #[test]
    fn uri_exposes_namespace_and_kind() {
        let uri = uri!("spotify:album:2112");
        assert_eq!(uri.namespace(), "spotify");
        assert_eq!(uri.kind().expect("kind"), "album");
    }

    #[test]
    fn uri_parse_rejects_values_without_a_scheme() {
        assert!(Uri::parse("not a uri").is_err());
    }

    #[test]
    fn value_round_trips_through_serde() {
        let input = Value::list(vec![
            Value::text("rush"),
            Value::reference(uri!("spotify:artist:rush")),
        ]);
        let encoded = serde_json::to_string(&input).expect("encoded");
        let decoded = serde_json::from_str::<Value>(&encoded).expect("decoded");
        assert_eq!(decoded, input);
    }

    #[test]
    fn builder_creates_assertion_facts_with_pending_tx_id() {
        let fact = Fact::builder()
            .source(uri!("agent:codex:local"))
            .entity(uri!("spotify:album:2112"))
            .field(uri!("spotify:displayName"))
            .value(Value::text("2112"))
            .build()
            .expect("fact");

        assert!(fact.tx_id.is_none());
        assert!(!fact.retraction);
    }

    #[test]
    fn builder_can_switch_to_retraction_mode() {
        let fact = Fact::builder()
            .source(uri!("agent:codex:local"))
            .entity(uri!("spotify:album:2112"))
            .field(uri!("spotify:displayName"))
            .value(Value::text("2112"))
            .retract()
            .build()
            .expect("fact");

        assert!(fact.retraction);
    }

    #[test]
    fn fact_macro_uses_explicit_source() {
        let fact = fact!(
            uri!("agent:codex:local"),
            uri!("spotify:album:2112"),
            uri!("spotify:displayName"),
            Value::text("2112")
        );

        assert_eq!(fact.source, uri!("agent:codex:local"));
    }

    #[test]
    fn fact_macro_defaults_source_to_internal() {
        let fact = fact!(
            uri!("spotify:album:2112"),
            uri!("spotify:displayName"),
            Value::text("2112")
        );

        assert_eq!(fact.source, uri!("poneglyph:internal"));
    }

    #[test]
    fn retraction_macro_marks_facts_as_retractions() {
        let fact = retraction!(
            uri!("spotify:album:2112"),
            uri!("spotify:displayName"),
            Value::text("2112")
        );

        assert_eq!(fact.source, uri!("poneglyph:internal"));
        assert!(fact.retraction);
    }
}
