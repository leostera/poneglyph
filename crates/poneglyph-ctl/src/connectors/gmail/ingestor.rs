use std::sync::Arc;

use poneglyph::{Fact, Poneglyph, Query, QueryResult, Uri, Value, fact, uri};

use crate::{CtlError, CtlResult};

use super::types::{GmailLabel, GmailMessage, GmailProfile, GmailSendAsAddress};

#[derive(Clone)]
pub struct GmailIngestor {
    poneglyph: Arc<Poneglyph>,
}

impl GmailIngestor {
    pub fn new(poneglyph: Arc<Poneglyph>) -> Self {
        Self { poneglyph }
    }

    pub async fn ingest_account_snapshot(
        &self,
        profile: &GmailProfile,
        send_as_addresses: &[GmailSendAsAddress],
        labels: &[GmailLabel],
        messages: &[GmailMessage],
    ) -> CtlResult<Vec<Fact>> {
        let account_entity = self.account_entity_uri(&profile.email_address).await?;
        let mut facts = self.account_facts(&account_entity, profile, send_as_addresses);

        for label in labels {
            let label_entity = self.label_entity_uri(&label.id).await?;
            facts.extend(self.label_facts(&label_entity, &account_entity, label));
        }

        for message in messages {
            let message_entity = self.message_entity_uri(&message.id).await?;
            facts.extend(self.message_facts(&message_entity, &account_entity, message));
        }

        Ok(facts)
    }

    async fn account_entity_uri(&self, email_address: &str) -> CtlResult<Uri> {
        self.resolve_entity("gmail:emailAddress", email_address, "gmail:account")
            .await?
            .map_or_else(|| Ok(uri!("gmail", "account")), Ok)
    }

    async fn label_entity_uri(&self, label_id: &str) -> CtlResult<Uri> {
        self.resolve_entity("gmail:labelId", label_id, "gmail:label")
            .await?
            .map_or_else(|| Ok(uri!("gmail", "label")), Ok)
    }

    async fn message_entity_uri(&self, message_id: &str) -> CtlResult<Uri> {
        self.resolve_entity("gmail:messageId", message_id, "gmail:message")
            .await?
            .map_or_else(|| Ok(uri!("gmail", "message")), Ok)
    }

    async fn resolve_entity(
        &self,
        field: &str,
        external_id: &str,
        kind: &str,
    ) -> CtlResult<Option<Uri>> {
        let query = format!(
            "'{field}'(Entity, {}), 'schema:type'(Entity, {})",
            Self::escape_query_text(external_id),
            Self::escape_query_text(kind),
        );
        let parsed =
            Query::parse(&query).map_err(|error| CtlError::GmailRequest(error.to_string()))?;
        let result = self
            .poneglyph
            .query(parsed)
            .await
            .map_err(|error| CtlError::GmailRequest(error.to_string()))?;
        Ok(Self::query_result_entity(&result))
    }

    fn escape_query_text(value: &str) -> String {
        serde_json::to_string(value).expect("valid query string")
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

    fn account_facts(
        &self,
        account_entity: &Uri,
        profile: &GmailProfile,
        send_as_addresses: &[GmailSendAsAddress],
    ) -> Vec<Fact> {
        let mut facts = vec![
            fact!(
                account_entity.clone(),
                uri!("schema:type"),
                Value::reference(uri!("gmail:account"))
            ),
            fact!(
                account_entity.clone(),
                uri!("schema:name"),
                Value::text(profile.email_address.clone())
            ),
            fact!(
                account_entity.clone(),
                uri!("gmail:emailAddress"),
                Value::text(profile.email_address.clone())
            ),
            fact!(
                account_entity.clone(),
                uri!("gmail:messagesTotal"),
                Value::integer(profile.messages_total)
            ),
            fact!(
                account_entity.clone(),
                uri!("gmail:threadsTotal"),
                Value::integer(profile.threads_total)
            ),
        ];
        if let Some(history_id) = &profile.history_id {
            facts.push(fact!(
                account_entity.clone(),
                uri!("gmail:historyId"),
                Value::text(history_id.clone())
            ));
        }
        for send_as in send_as_addresses {
            facts.push(fact!(
                account_entity.clone(),
                uri!("gmail:sendAsAddress"),
                Value::text(send_as.send_as_email.clone())
            ));
        }
        facts
    }

    fn label_facts(
        &self,
        label_entity: &Uri,
        account_entity: &Uri,
        label: &GmailLabel,
    ) -> Vec<Fact> {
        let mut facts = vec![
            fact!(
                label_entity.clone(),
                uri!("schema:type"),
                Value::reference(uri!("gmail:label"))
            ),
            fact!(
                label_entity.clone(),
                uri!("schema:name"),
                Value::text(label.name.clone())
            ),
            fact!(
                label_entity.clone(),
                uri!("gmail:labelId"),
                Value::text(label.id.clone())
            ),
            fact!(
                label_entity.clone(),
                uri!("gmail:account"),
                Value::reference(account_entity.clone())
            ),
        ];
        if let Some(label_type) = &label.label_type {
            facts.push(fact!(
                label_entity.clone(),
                uri!("gmail:labelType"),
                Value::text(label_type.clone())
            ));
        }
        if let Some(label_list_visibility) = &label.label_list_visibility {
            facts.push(fact!(
                label_entity.clone(),
                uri!("gmail:labelListVisibility"),
                Value::text(label_list_visibility.clone())
            ));
        }
        if let Some(message_list_visibility) = &label.message_list_visibility {
            facts.push(fact!(
                label_entity.clone(),
                uri!("gmail:messageListVisibility"),
                Value::text(message_list_visibility.clone())
            ));
        }
        if let Some(messages_total) = label.messages_total {
            facts.push(fact!(
                label_entity.clone(),
                uri!("gmail:labelMessagesTotal"),
                Value::integer(messages_total)
            ));
        }
        if let Some(messages_unread) = label.messages_unread {
            facts.push(fact!(
                label_entity.clone(),
                uri!("gmail:labelMessagesUnread"),
                Value::integer(messages_unread)
            ));
        }
        if let Some(threads_total) = label.threads_total {
            facts.push(fact!(
                label_entity.clone(),
                uri!("gmail:labelThreadsTotal"),
                Value::integer(threads_total)
            ));
        }
        if let Some(threads_unread) = label.threads_unread {
            facts.push(fact!(
                label_entity.clone(),
                uri!("gmail:labelThreadsUnread"),
                Value::integer(threads_unread)
            ));
        }
        facts
    }

    fn message_facts(
        &self,
        message_entity: &Uri,
        account_entity: &Uri,
        message: &GmailMessage,
    ) -> Vec<Fact> {
        let mut facts = vec![
            fact!(
                message_entity.clone(),
                uri!("schema:type"),
                Value::reference(uri!("gmail:message"))
            ),
            fact!(
                message_entity.clone(),
                uri!("gmail:messageId"),
                Value::text(message.id.clone())
            ),
            fact!(
                message_entity.clone(),
                uri!("gmail:threadId"),
                Value::text(message.thread_id.clone())
            ),
            fact!(
                message_entity.clone(),
                uri!("gmail:account"),
                Value::reference(account_entity.clone())
            ),
        ];
        if let Some(history_id) = &message.history_id {
            facts.push(fact!(
                message_entity.clone(),
                uri!("gmail:historyId"),
                Value::text(history_id.clone())
            ));
        }
        if let Some(internal_date) = message.internal_date {
            facts.push(fact!(
                message_entity.clone(),
                uri!("gmail:internalDate"),
                Value::date_time(internal_date)
            ));
        }
        if let Some(snippet) = &message.snippet {
            facts.push(fact!(
                message_entity.clone(),
                uri!("gmail:snippet"),
                Value::text(snippet.clone())
            ));
        }
        if let Some(subject) = &message.subject {
            facts.push(fact!(
                message_entity.clone(),
                uri!("gmail:subject"),
                Value::text(subject.clone())
            ));
        }
        if let Some(from) = &message.from {
            facts.push(fact!(
                message_entity.clone(),
                uri!("gmail:from"),
                Value::text(from.clone())
            ));
        }
        if let Some(to) = &message.to {
            facts.push(fact!(
                message_entity.clone(),
                uri!("gmail:to"),
                Value::text(to.clone())
            ));
        }
        facts
    }
}
