use poneglyph::{Fact, Uri, Value, fact, uri};

pub(super) struct GmailSchema;

impl GmailSchema {
    pub(super) fn facts() -> Vec<Fact> {
        let mut facts = vec![
            fact!(
                uri!("gmail:namespace"),
                uri!("schema:type"),
                Value::reference(uri!("schema:namespace"))
            ),
            fact!(
                uri!("gmail:namespace"),
                uri!("schema:name"),
                Value::text("Gmail")
            ),
            fact!(
                uri!("gmail:namespace"),
                uri!("schema:doc"),
                Value::text("Schema entities and metadata ingested from Gmail.")
            ),
            fact!(
                uri!("gmail:account"),
                uri!("schema:type"),
                Value::reference(uri!("schema:kind"))
            ),
            fact!(
                uri!("gmail:account"),
                uri!("schema:name"),
                Value::text("Account")
            ),
            fact!(
                uri!("gmail:label"),
                uri!("schema:type"),
                Value::reference(uri!("schema:kind"))
            ),
            fact!(
                uri!("gmail:label"),
                uri!("schema:name"),
                Value::text("Label")
            ),
            fact!(
                uri!("gmail:message"),
                uri!("schema:type"),
                Value::reference(uri!("schema:kind"))
            ),
            fact!(
                uri!("gmail:message"),
                uri!("schema:name"),
                Value::text("Message")
            ),
        ];

        facts.extend(Self::field(
            uri!("gmail:emailAddress"),
            "Email Address",
            "The Gmail account email address.",
            uri!("gmail:account"),
            true,
        ));
        facts.extend(Self::field(
            uri!("gmail:historyId"),
            "History ID",
            "The Gmail change history identifier.",
            uri!("gmail:account"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:messagesTotal"),
            "Messages Total",
            "Total messages in the Gmail mailbox.",
            uri!("gmail:account"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:sendAsAddress"),
            "Send As Address",
            "An address configured for sending mail from this Gmail account.",
            uri!("gmail:account"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:threadsTotal"),
            "Threads Total",
            "Total threads in the Gmail mailbox.",
            uri!("gmail:account"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:labelId"),
            "Label ID",
            "The Gmail label identifier.",
            uri!("gmail:label"),
            true,
        ));
        facts.extend(Self::field(
            uri!("gmail:labelType"),
            "Label Type",
            "The Gmail label type (system or user).",
            uri!("gmail:label"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:messageListVisibility"),
            "Message List Visibility",
            "How the label appears in the Gmail message list.",
            uri!("gmail:label"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:messageId"),
            "Message ID",
            "The Gmail message identifier.",
            uri!("gmail:message"),
            true,
        ));
        facts.extend(Self::field(
            uri!("gmail:threadId"),
            "Thread ID",
            "The Gmail thread identifier containing the message.",
            uri!("gmail:message"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:subject"),
            "Subject",
            "The message subject header.",
            uri!("gmail:message"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:from"),
            "From",
            "The message sender header.",
            uri!("gmail:message"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:to"),
            "To",
            "The message recipient header.",
            uri!("gmail:message"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:snippet"),
            "Snippet",
            "The message snippet preview.",
            uri!("gmail:message"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:internalDate"),
            "Internal Date",
            "The Gmail internal timestamp for a message.",
            uri!("gmail:message"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:account"),
            "Account",
            "Reference to the parent Gmail account.",
            uri!("gmail:label"),
            false,
        ));
        facts.extend(Self::field(
            uri!("gmail:account"),
            "Account",
            "Reference to the parent Gmail account.",
            uri!("gmail:message"),
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
}
