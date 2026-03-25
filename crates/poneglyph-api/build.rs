use std::{fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let schema_path = manifest_dir.join("schema.graphql");

    fs::write(&schema_path, schema_sdl()).expect("write schema.graphql");

    println!("cargo:rerun-if-changed=src/graphql/schema.rs");
    println!("cargo:rerun-if-changed=src/services/google.rs");
    println!("cargo:rerun-if-changed=build.rs");
}

fn schema_sdl() -> &'static str {
    r#"type ConnectorStatus {
  name: String!
  enabled: Boolean!
  connected: Boolean!
  selectedResourceCount: Int!
  lastSyncedAt: String
  lastError: String
}

type ConnectorSyncResult {
  name: String!
  synced: Boolean!
  message: String!
}

type GoogleCalendarResource {
  calendarId: String!
  summary: String!
  description: String
  timeZone: String
  primary: Boolean!
  selected: Boolean!
}

type Mutation {
  discoverGoogleCalendars: [GoogleCalendarResource!]!
  selectGoogleCalendars(input: SelectGoogleCalendarsInput!): [GoogleCalendarResource!]!
  syncConnector(name: String!): ConnectorSyncResult!
}

type Query {
  googleCalendars: [GoogleCalendarResource!]!
  connectorStatuses: [ConnectorStatus!]!
}

input SelectGoogleCalendarsInput {
  calendarIds: [String!]!
}

"""
Directs the executor to include this field or fragment only when the `if` argument is true.
"""
directive @include(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT

"""
Directs the executor to skip this field or fragment when the `if` argument is true.
"""
directive @skip(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT

schema {
  query: Query
  mutation: Mutation
}
"#
}
