use std::collections::HashMap;
use std::sync::Arc;

use poneglyph::{Fact, Poneglyph, Query, QueryResult, Uri, Value, fact, uri};

use crate::CtlResult;

use super::types::{GoogleCalendarEvent, GoogleCalendarResource, GoogleCalendarTime};

fn escape_query_text(value: &str) -> String {
    serde_json::to_string(value).expect("valid query string")
}

async fn resolve_entity(
    poneglyph: &Arc<Poneglyph>,
    field: &str,
    external_id: &str,
    kind: &str,
) -> CtlResult<Option<Uri>> {
    let query = format!(
        "'{field}'(Entity, {}), 'schema:type'(Entity, {})",
        escape_query_text(external_id),
        escape_query_text(kind),
    );
    let parsed =
        Query::parse(&query).map_err(|error| crate::CtlError::GcalRequest(error.to_string()))?;
    let result = poneglyph
        .query(parsed)
        .await
        .map_err(|error| crate::CtlError::GcalRequest(error.to_string()))?;
    Ok(query_result_entity(&result))
}

fn query_result_entity(result: &QueryResult) -> Option<Uri> {
    result
        .substitutions()
        .first()
        .and_then(|substitution| substitution.lookup("Entity"))
        .and_then(|value| match value {
            datafox::Value::String(value) => Uri::parse(value.clone()).ok(),
            datafox::Value::Integer(_) => None,
        })
}

pub async fn calendar_entity_uri(poneglyph: &Arc<Poneglyph>, calendar_id: &str) -> CtlResult<Uri> {
    resolve_entity(poneglyph, "gcal:calendarId", calendar_id, "gcal:calendar")
        .await?
        .map_or_else(|| Ok(uri!("gcal", "calendar")), Ok)
}

pub async fn event_entity_uri(poneglyph: &Arc<Poneglyph>, event_id: &str) -> CtlResult<Uri> {
    resolve_entity(poneglyph, "gcal:eventId", event_id, "gcal:event")
        .await?
        .map_or_else(|| Ok(uri!("gcal", "event")), Ok)
}

pub async fn calendar_facts(
    poneglyph: &Arc<Poneglyph>,
    calendar: &GoogleCalendarResource,
) -> CtlResult<(Uri, Vec<Fact>)> {
    let entity = calendar_entity_uri(poneglyph, &calendar.calendar_id).await?;
    let mut facts = vec![
        fact!(
            entity.clone(),
            uri!("schema:type"),
            Value::reference(uri!("gcal:calendar"))
        ),
        fact!(
            entity.clone(),
            uri!("schema:name"),
            Value::text(calendar.summary.clone())
        ),
        fact!(
            entity.clone(),
            uri!("gcal:calendarId"),
            Value::text(calendar.calendar_id.clone())
        ),
        fact!(
            entity.clone(),
            uri!("gcal:primary"),
            Value::boolean(calendar.primary)
        ),
    ];
    if let Some(description) = &calendar.description {
        facts.push(fact!(
            entity.clone(),
            uri!("gcal:description"),
            Value::text(description.clone())
        ));
    }
    if let Some(time_zone) = &calendar.time_zone {
        facts.push(fact!(
            entity.clone(),
            uri!("gcal:timeZone"),
            Value::text(time_zone.clone())
        ));
    }
    Ok((entity, facts))
}

pub async fn event_facts(
    poneglyph: &Arc<Poneglyph>,
    calendar_entity: &Uri,
    event: &GoogleCalendarEvent,
) -> CtlResult<(Uri, Vec<Fact>)> {
    let entity = event_entity_uri(poneglyph, &event.event_id).await?;
    let mut facts = vec![
        fact!(
            entity.clone(),
            uri!("schema:type"),
            Value::reference(uri!("gcal:event"))
        ),
        fact!(
            entity.clone(),
            uri!("gcal:eventId"),
            Value::text(event.event_id.clone())
        ),
        fact!(
            entity.clone(),
            uri!("gcal:calendar"),
            Value::reference(calendar_entity.clone())
        ),
    ];
    if let Some(summary) = &event.summary {
        facts.push(fact!(
            entity.clone(),
            uri!("schema:name"),
            Value::text(summary.clone())
        ));
    }
    if let Some(description) = &event.description {
        facts.push(fact!(
            entity.clone(),
            uri!("gcal:description"),
            Value::text(description.clone())
        ));
    }
    if let Some(status) = &event.status {
        facts.push(fact!(
            entity.clone(),
            uri!("gcal:status"),
            Value::text(status.clone())
        ));
    }
    if let Some(html_link) = &event.html_link {
        facts.push(fact!(
            entity.clone(),
            uri!("gcal:htmlLink"),
            Value::text(html_link.clone())
        ));
    }
    if let Some(start) = &event.start {
        facts.push(fact!(
            entity.clone(),
            uri!("gcal:startAt"),
            calendar_time_value(start)
        ));
    }
    if let Some(end) = &event.end {
        facts.push(fact!(
            entity.clone(),
            uri!("gcal:endAt"),
            calendar_time_value(end)
        ));
    }
    Ok((entity, facts))
}

fn calendar_time_value(time: &GoogleCalendarTime) -> Value {
    match time {
        GoogleCalendarTime::Date(value) => Value::date(*value),
        GoogleCalendarTime::DateTime(value) => Value::date_time(*value),
    }
}

pub async fn facts_for_selected_calendars(
    poneglyph: &Arc<Poneglyph>,
    calendars: Vec<GoogleCalendarResource>,
    events_by_calendar: HashMap<String, Vec<GoogleCalendarEvent>>,
) -> CtlResult<Vec<Fact>> {
    let mut facts = Vec::new();
    for calendar in calendars {
        let (calendar_entity, calendar_facts) = calendar_facts(poneglyph, &calendar).await?;
        facts.extend(calendar_facts);
        if let Some(events) = events_by_calendar.get(&calendar.calendar_id) {
            for event in events {
                let (_, event_facts) = event_facts(poneglyph, &calendar_entity, event).await?;
                facts.extend(event_facts);
            }
        }
    }
    Ok(facts)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use chrono::{DateTime, NaiveDate, Utc};
    use poneglyph::{FactService, InMemoryFactStore, QueryResult, Workspace, uri};

    use super::{facts_for_selected_calendars, query_result_entity};
    use crate::connectors::gcal::GoogleCalendarResource;
    use crate::connectors::gcal::types::{GoogleCalendarEvent, GoogleCalendarTime};

    #[tokio::test]
    async fn ingestor_shapes_calendar_and_event_facts() {
        let facts = Arc::new(
            FactService::builder()
                .with_store(InMemoryFactStore::new())
                .build()
                .expect("facts"),
        );
        let tempdir = tempfile::tempdir().expect("tempdir");
        let poneglyph = Arc::new(
            poneglyph::Poneglyph::builder()
                .with_workspace(Workspace::at(tempdir.path()))
                .with_fact_service_arc(facts)
                .build()
                .await
                .expect("poneglyph"),
        );
        let calendar = GoogleCalendarResource {
            calendar_id: "primary".to_string(),
            summary: "Primary".to_string(),
            description: Some("Main".to_string()),
            time_zone: Some("Europe/Prague".to_string()),
            primary: true,
            selected: true,
        };
        let event = GoogleCalendarEvent {
            event_id: "event-1".to_string(),
            status: Some("confirmed".to_string()),
            summary: Some("Standup".to_string()),
            description: Some("Daily sync".to_string()),
            html_link: Some("https://calendar.google.com/event?eid=1".to_string()),
            start: Some(GoogleCalendarTime::DateTime(
                DateTime::parse_from_rfc3339("2026-03-18T09:00:00Z")
                    .expect("datetime")
                    .with_timezone(&Utc),
            )),
            end: Some(GoogleCalendarTime::Date(
                NaiveDate::from_ymd_opt(2026, 3, 18).expect("date"),
            )),
        };

        let facts = facts_for_selected_calendars(
            &poneglyph,
            vec![calendar],
            HashMap::from([("primary".to_string(), vec![event])]),
        )
        .await
        .expect("facts");

        assert!(
            facts
                .iter()
                .any(|fact| fact.field == uri!("gcal:calendarId"))
        );
        assert!(facts.iter().any(|fact| fact.field == uri!("gcal:eventId")));
        assert!(facts.iter().any(|fact| fact.field == uri!("gcal:calendar")));
        assert!(facts.iter().any(|fact| fact.field == uri!("gcal:startAt")));
        assert!(facts.iter().any(|fact| fact.field == uri!("gcal:endAt")));
    }

    #[test]
    fn query_result_entity_returns_none_for_empty_results() {
        assert!(query_result_entity(&QueryResult::default()).is_none());
    }
}
