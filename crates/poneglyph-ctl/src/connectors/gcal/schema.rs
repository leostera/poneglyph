use poneglyph::{Fact, Uri, Value, fact, uri};

pub(super) fn schema_facts() -> Vec<Fact> {
    let mut facts = vec![
        fact!(
            uri!("gcal:namespace"),
            uri!("schema:type"),
            Value::reference(uri!("schema:namespace"))
        ),
        fact!(
            uri!("gcal:namespace"),
            uri!("schema:name"),
            Value::text("Google Calendar")
        ),
        fact!(
            uri!("gcal:namespace"),
            uri!("schema:doc"),
            Value::text("Schema entities and metadata ingested from Google Calendar.")
        ),
        fact!(
            uri!("gcal:calendar"),
            uri!("schema:type"),
            Value::reference(uri!("schema:kind"))
        ),
        fact!(
            uri!("gcal:calendar"),
            uri!("schema:name"),
            Value::text("Calendar")
        ),
        fact!(
            uri!("gcal:calendar"),
            uri!("schema:doc"),
            Value::text("A Google Calendar calendar.")
        ),
        fact!(
            uri!("gcal:event"),
            uri!("schema:type"),
            Value::reference(uri!("schema:kind"))
        ),
        fact!(
            uri!("gcal:event"),
            uri!("schema:name"),
            Value::text("Event")
        ),
        fact!(
            uri!("gcal:event"),
            uri!("schema:doc"),
            Value::text("A Google Calendar event.")
        ),
    ];

    facts.extend(field(
        uri!("gcal:calendarId"),
        "Calendar ID",
        "The external Google Calendar identifier.",
        uri!("gcal:calendar"),
        true,
    ));
    facts.extend(field(
        uri!("gcal:eventId"),
        "Event ID",
        "The external Google Calendar event identifier.",
        uri!("gcal:event"),
        true,
    ));
    facts.extend(field(
        uri!("gcal:description"),
        "Description",
        "Long-form event or calendar description.",
        uri!("gcal:event"),
        false,
    ));
    facts.extend(field(
        uri!("gcal:timeZone"),
        "Time Zone",
        "The calendar time zone.",
        uri!("gcal:calendar"),
        false,
    ));
    facts.extend(field(
        uri!("gcal:primary"),
        "Primary",
        "Whether this is the primary Google calendar.",
        uri!("gcal:calendar"),
        false,
    ));
    facts.extend(field(
        uri!("gcal:calendar"),
        "Calendar",
        "Reference to the parent Google calendar.",
        uri!("gcal:event"),
        false,
    ));
    facts.extend(field(
        uri!("gcal:status"),
        "Status",
        "The Google Calendar event status.",
        uri!("gcal:event"),
        false,
    ));
    facts.extend(field(
        uri!("gcal:startAt"),
        "Start At",
        "The event start date or timestamp.",
        uri!("gcal:event"),
        false,
    ));
    facts.extend(field(
        uri!("gcal:endAt"),
        "End At",
        "The event end date or timestamp.",
        uri!("gcal:event"),
        false,
    ));
    facts.extend(field(
        uri!("gcal:htmlLink"),
        "HTML Link",
        "The canonical Google Calendar browser URL for the event.",
        uri!("gcal:event"),
        false,
    ));

    facts
}

fn field(field_uri: Uri, name: &str, doc: &str, domain: Uri, identity: bool) -> Vec<Fact> {
    let mut facts = vec![
        fact!(
            field_uri.clone(),
            uri!("schema:type"),
            Value::reference(uri!("schema:field"))
        ),
        fact!(field_uri.clone(), uri!("schema:name"), Value::text(name)),
        fact!(field_uri.clone(), uri!("schema:doc"), Value::text(doc)),
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
