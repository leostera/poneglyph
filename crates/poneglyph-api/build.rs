use std::{fs, path::PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let schema_path = manifest_dir.join("schema.graphql");

    fs::write(&schema_path, schema_sdl()).expect("write schema.graphql");

    println!("cargo:rerun-if-changed=src/graphql/schema.rs");
    println!("cargo:rerun-if-changed=src/services/agent.rs");
    println!("cargo:rerun-if-changed=src/services/filesystem.rs");
    println!("cargo:rerun-if-changed=src/services/google.rs");
    println!("cargo:rerun-if-changed=build.rs");
}

fn schema_sdl() -> &'static str {
    r#"type AgentAuditEvent {
  id: String!
  runId: String!
  seq: Int!
  eventType: String!
  payloadJson: String!
  occurredAt: String!
}

type AgentAuditRun {
  id: String!
  agentKey: String!
  sessionId: String
  source: String!
  status: String!
  inputSummary: String
  replySummary: String
  errorSummary: String
  startedAt: String!
  finishedAt: String
}

type AiProvider {
  id: Int!
  providerKey: String!
  displayName: String!
  baseUrl: String!
  defaultModel: String!
  enabled: Boolean!
  hasApiKey: Boolean!
}

type ConnectorStatus {
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

type EntityDetail {
  uri: String!
  namespace: String!
  kind: String!
  fields: [EntityField!]!
}

type EntityField {
  field: String!
  value: String!
}

type EntitySummary {
  uri: String!
  namespace: String!
  kind: String!
}

type FilesystemConnection {
  id: Int!
  name: String!
  rootPath: String!
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

type KnowledgeGraphSchema {
  namespaces: [SchemaNamespace!]!
  kinds: [SchemaKind!]!
  fields: [SchemaField!]!
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
  discoverPlexLibraries(baseUrl: String!, token: String!): [PlexLibraryOption!]!
  saveFilesystemConnection(input: SaveFilesystemConnectionInput!): FilesystemConnection!
  deleteFilesystemConnection(connectionId: Int!): Boolean!
  saveAiProvider(input: SaveAiProviderInput!): AiProvider!
  deleteAiProvider(id: Int!): Boolean!
  sendPoneglyphAgentMessage(input: SendPoneglyphAgentMessageInput!): PoneglyphAgentReply!
}

type PlexConnection {
  id: Int!
  name: String!
  baseUrl: String!
  libraries: [PlexLibraryOption!]!
  lastSyncedAt: String
  lastError: String
}

type PlexDetection {
  baseUrl: String!
  token: String
  machineIdentifier: String
  libraries: [PlexLibraryOption!]!
}

type PlexLibraryOption {
  id: String!
  name: String!
}

type PoneglyphAgentReply {
  sessionId: String!
  runId: String!
  reply: String!
}

type Query {
  googleCalendarConnections: [GoogleCalendarConnection!]!
  googleCalendars: [GoogleCalendarResource!]!
  connectorStatuses: [ConnectorStatus!]!
  plexConnections: [PlexConnection!]!
  detectLocalPlexConnection: PlexDetection!
  filesystemConnections: [FilesystemConnection!]!
  gmailConnections: [GoogleCalendarConnection!]!
  gmailConnectionSummary(connectionId: Int!): GmailConnectionSummary!
  aiProviders: [AiProvider!]!
  agentAuditRuns(limit: Int, offset: Int): [AgentAuditRun!]!
  agentAuditEvents(runId: String!): [AgentAuditEvent!]!
  entities(limit: Int, offset: Int): [EntitySummary!]!
  schemaDefinition: KnowledgeGraphSchema!
  entityKinds: [String!]!
  entity(uri: String!): EntityDetail
}

input SaveAiProviderInput {
  providerKey: String!
  displayName: String!
  baseUrl: String!
  defaultModel: String!
  apiKey: String!
  enabled: Boolean!
}

input SaveFilesystemConnectionInput {
  name: String!
  rootPath: String!
}

input SavePlexConnectionInput {
  name: String!
  baseUrl: String!
  token: String!
  libraries: [String!]!
}

type SchemaField {
  uri: String!
  name: String
  domain: String
  range: String
}

type SchemaKind {
  uri: String!
  name: String
}

type SchemaNamespace {
  uri: String!
  name: String
}

input SelectGoogleCalendarsInput {
  calendarIds: [String!]!
}

input SendPoneglyphAgentMessageInput {
  message: String!
  sessionId: String
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
