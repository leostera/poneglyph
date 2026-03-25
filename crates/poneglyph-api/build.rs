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

type GmailConnectionSummary {
  connectionId: Int!
  sendingAddresses: [String!]!
  mailboxes: [String!]!
  labels: [String!]!
  emails: [String!]!
  lastEmailReceivedAt: String
}

type GoogleCalendarConnection {
  id: Int!
  label: String!
  selectedResourceCount: Int!
  lastSyncedAt: String
  lastError: String
  calendars: [GoogleCalendarResource!]!
}

type GoogleCalendarResource {
  connectionId: Int!
  calendarId: String!
  summary: String!
  description: String
  timeZone: String
  primary: Boolean!
  selected: Boolean!
}

type Mutation {
  discoverGoogleCalendars: [GoogleCalendarResource!]!
  discoverGoogleCalendarsForConnection(connectionId: Int!): [GoogleCalendarResource!]!
  selectGoogleCalendars(input: SelectGoogleCalendarsInput!): [GoogleCalendarResource!]!
  selectGoogleCalendarsForConnection(connectionId: Int!, input: SelectGoogleCalendarsInput!): [GoogleCalendarResource!]!
  syncConnector(name: String!): ConnectorSyncResult!
  deleteGoogleConnection(connectionId: Int!): Boolean!
  savePlexConnection(input: SavePlexConnectionInput!): PlexConnection!
  deletePlexConnection(connectionId: Int!): Boolean!
  discoverPlexLibraries(baseUrl: String!, token: String!): [String!]!
}

type PlexConnection {
  id: Int!
  name: String!
  baseUrl: String!
  libraries: [String!]!
  lastSyncedAt: String
  lastError: String
}

type PlexDetection {
  baseUrl: String!
  token: String
}

type Query {
  googleCalendarConnections: [GoogleCalendarConnection!]!
  googleCalendars: [GoogleCalendarResource!]!
  connectorStatuses: [ConnectorStatus!]!
  plexConnections: [PlexConnection!]!
  detectLocalPlexConnection: PlexDetection!
  gmailConnections: [GoogleCalendarConnection!]!
  gmailConnectionSummary(connectionId: Int!): GmailConnectionSummary!
}

input SavePlexConnectionInput {
  name: String!
  baseUrl: String!
  token: String!
  libraries: [String!]!
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
