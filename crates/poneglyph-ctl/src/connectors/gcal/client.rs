use reqwest::Client;

use crate::{CtlError, CtlResult};

use super::types::{
    CalendarListResponse, EventListResponse, GoogleCalendarEvent, GoogleCalendarResource,
    GoogleCalendarTime,
};

#[derive(Debug, Clone)]
pub struct GcalClient {
    http: Client,
    base_url: String,
}

impl Default for GcalClient {
    fn default() -> Self {
        Self {
            http: Client::new(),
            base_url: std::env::var("PONEGLYPH_GCAL_API_BASE_URL")
                .unwrap_or_else(|_| "https://www.googleapis.com".to_string()),
        }
    }
}

impl GcalClient {
    #[cfg(test)]
    pub fn new_with_base_url(http: Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
        }
    }

    pub async fn list_calendars(
        &self,
        access_token: &str,
    ) -> CtlResult<Vec<GoogleCalendarResource>> {
        let response = self
            .http
            .get(format!(
                "{}/calendar/v3/users/me/calendarList",
                self.base_url.trim_end_matches('/')
            ))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CtlError::GcalRequest(error.to_string()))?;

        if !response.status().is_success() {
            return Err(CtlError::GcalUnexpectedStatus(response.status().as_u16()));
        }

        let payload: CalendarListResponse = response
            .json()
            .await
            .map_err(|error| CtlError::GcalResponseDecode(error.to_string()))?;

        Ok(payload
            .items
            .into_iter()
            .map(|item| GoogleCalendarResource {
                calendar_id: item.id,
                summary: item
                    .summary
                    .unwrap_or_else(|| "Untitled calendar".to_string()),
                description: item.description,
                time_zone: item.time_zone,
                primary: item.primary,
                selected: false,
            })
            .collect())
    }

    pub async fn list_events(
        &self,
        access_token: &str,
        calendar_id: &str,
    ) -> CtlResult<Vec<GoogleCalendarEvent>> {
        let calendar_id: String =
            url::form_urlencoded::byte_serialize(calendar_id.as_bytes()).collect();
        let response = self
            .http
            .get(format!(
                "{}/calendar/v3/calendars/{calendar_id}/events",
                self.base_url.trim_end_matches('/')
            ))
            .query(&[("singleEvents", "true"), ("orderBy", "startTime")])
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CtlError::GcalRequest(error.to_string()))?;

        if !response.status().is_success() {
            return Err(CtlError::GcalUnexpectedStatus(response.status().as_u16()));
        }

        let payload: EventListResponse = response
            .json()
            .await
            .map_err(|error| CtlError::GcalResponseDecode(error.to_string()))?;

        Ok(payload
            .items
            .into_iter()
            .map(|item| GoogleCalendarEvent {
                event_id: item.id,
                status: item.status,
                summary: item.summary,
                description: item.description,
                html_link: item.html_link,
                start: item.start.as_ref().and_then(GoogleCalendarTime::parse),
                end: item.end.as_ref().and_then(GoogleCalendarTime::parse),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use axum::{Json, Router, routing::get};
    use reqwest::Client;
    use serde_json::json;

    use super::GcalClient;

    fn next_http_bind_addr() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("ephemeral tcp listener");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);
        addr.to_string()
    }

    #[tokio::test]
    async fn gcal_client_lists_calendars() {
        let bind_addr = next_http_bind_addr();
        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .expect("listener");
        let server = tokio::spawn(async move {
            let app = Router::new().route(
                "/calendar/v3/users/me/calendarList",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": "primary",
                                "summary": "Primary",
                                "description": "Main calendar",
                                "timeZone": "Europe/Prague",
                                "primary": true
                            }
                        ]
                    }))
                }),
            );
            axum::serve(listener, app).await.expect("serve");
        });

        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http");
        let client = GcalClient::new_with_base_url(http, format!("http://{bind_addr}"));

        let calendars = client
            .list_calendars("access-token")
            .await
            .expect("calendars");

        assert_eq!(calendars.len(), 1);
        assert_eq!(calendars[0].calendar_id, "primary");
        assert_eq!(calendars[0].summary, "Primary");
        assert!(calendars[0].primary);

        server.abort();
    }

    #[tokio::test]
    async fn gcal_client_lists_events() {
        let bind_addr = next_http_bind_addr();
        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .expect("listener");
        let server = tokio::spawn(async move {
            let app = Router::new().route(
                "/calendar/v3/calendars/primary/events",
                get(|| async {
                    Json(json!({
                        "items": [
                            {
                                "id": "event-1",
                                "status": "confirmed",
                                "summary": "Standup",
                                "description": "Daily sync",
                                "htmlLink": "https://calendar.google.com/event?eid=1",
                                "start": { "dateTime": "2026-03-18T09:00:00Z" },
                                "end": { "dateTime": "2026-03-18T09:30:00Z" }
                            }
                        ]
                    }))
                }),
            );
            axum::serve(listener, app).await.expect("serve");
        });

        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http");
        let client = GcalClient::new_with_base_url(http, format!("http://{bind_addr}"));

        let events = client
            .list_events("access-token", "primary")
            .await
            .expect("events");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, "event-1");
        assert_eq!(events[0].summary.as_deref(), Some("Standup"));

        server.abort();
    }
}
