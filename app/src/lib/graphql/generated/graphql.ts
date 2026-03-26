/* eslint-disable */
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type Maybe<T> = T | null;
export type InputMaybe<T> = T | null | undefined;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
};

export type AgentAuditEvent = {
  __typename?: 'AgentAuditEvent';
  eventType: Scalars['String']['output'];
  id: Scalars['String']['output'];
  occurredAt: Scalars['String']['output'];
  payloadJson: Scalars['String']['output'];
  runId: Scalars['String']['output'];
  seq: Scalars['Int']['output'];
};

export type AgentAuditRun = {
  __typename?: 'AgentAuditRun';
  agentKey: Scalars['String']['output'];
  errorSummary?: Maybe<Scalars['String']['output']>;
  finishedAt?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  inputSummary?: Maybe<Scalars['String']['output']>;
  replySummary?: Maybe<Scalars['String']['output']>;
  sessionId?: Maybe<Scalars['String']['output']>;
  source: Scalars['String']['output'];
  startedAt: Scalars['String']['output'];
  status: Scalars['String']['output'];
};

export type AiProvider = {
  __typename?: 'AiProvider';
  baseUrl: Scalars['String']['output'];
  defaultModel: Scalars['String']['output'];
  displayName: Scalars['String']['output'];
  enabled: Scalars['Boolean']['output'];
  hasApiKey: Scalars['Boolean']['output'];
  id: Scalars['Int']['output'];
  providerKey: Scalars['String']['output'];
};

export type ConnectorStatus = {
  __typename?: 'ConnectorStatus';
  connected: Scalars['Boolean']['output'];
  enabled: Scalars['Boolean']['output'];
  lastError?: Maybe<Scalars['String']['output']>;
  lastSyncedAt?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  selectedResourceCount: Scalars['Int']['output'];
};

export type ConnectorSyncResult = {
  __typename?: 'ConnectorSyncResult';
  message: Scalars['String']['output'];
  name: Scalars['String']['output'];
  synced: Scalars['Boolean']['output'];
};

export type EntityDetail = {
  __typename?: 'EntityDetail';
  fields: Array<EntityField>;
  kind: Scalars['String']['output'];
  namespace: Scalars['String']['output'];
  uri: Scalars['String']['output'];
};

export type EntityField = {
  __typename?: 'EntityField';
  field: Scalars['String']['output'];
  value: Scalars['String']['output'];
};

export type EntitySummary = {
  __typename?: 'EntitySummary';
  kind: Scalars['String']['output'];
  namespace: Scalars['String']['output'];
  uri: Scalars['String']['output'];
};

export type FilesystemConnection = {
  __typename?: 'FilesystemConnection';
  id: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  rootPath: Scalars['String']['output'];
};

export type GmailConnectionSummary = {
  __typename?: 'GmailConnectionSummary';
  connectionId: Scalars['Int']['output'];
  emails: Array<Scalars['String']['output']>;
  labels: Array<Scalars['String']['output']>;
  lastEmailReceivedAt?: Maybe<Scalars['String']['output']>;
  mailboxes: Array<Scalars['String']['output']>;
  sendingAddresses: Array<Scalars['String']['output']>;
};

export type GoogleCalendarConnection = {
  __typename?: 'GoogleCalendarConnection';
  calendars: Array<GoogleCalendarResource>;
  id: Scalars['Int']['output'];
  label: Scalars['String']['output'];
  lastError?: Maybe<Scalars['String']['output']>;
  lastSyncedAt?: Maybe<Scalars['String']['output']>;
  selectedResourceCount: Scalars['Int']['output'];
};

export type GoogleCalendarResource = {
  __typename?: 'GoogleCalendarResource';
  calendarId: Scalars['String']['output'];
  connectionId: Scalars['Int']['output'];
  description?: Maybe<Scalars['String']['output']>;
  primary: Scalars['Boolean']['output'];
  selected: Scalars['Boolean']['output'];
  summary: Scalars['String']['output'];
  timeZone?: Maybe<Scalars['String']['output']>;
};

export type KnowledgeGraphSchema = {
  __typename?: 'KnowledgeGraphSchema';
  fields: Array<SchemaField>;
  kinds: Array<SchemaKind>;
  namespaces: Array<SchemaNamespace>;
};

export type Mutation = {
  __typename?: 'Mutation';
  deleteAiProvider: Scalars['Boolean']['output'];
  deleteFilesystemConnection: Scalars['Boolean']['output'];
  deleteGoogleConnection: Scalars['Boolean']['output'];
  deletePlexConnection: Scalars['Boolean']['output'];
  discoverGoogleCalendars: Array<GoogleCalendarResource>;
  discoverGoogleCalendarsForConnection: Array<GoogleCalendarResource>;
  discoverPlexLibraries: Array<PlexLibraryOption>;
  saveAiProvider: AiProvider;
  saveFilesystemConnection: FilesystemConnection;
  savePlexConnection: PlexConnection;
  selectGoogleCalendars: Array<GoogleCalendarResource>;
  selectGoogleCalendarsForConnection: Array<GoogleCalendarResource>;
  sendPoneglyphAgentMessage: PoneglyphAgentReply;
  syncConnector: ConnectorSyncResult;
};


export type MutationDeleteAiProviderArgs = {
  id: Scalars['Int']['input'];
};


export type MutationDeleteFilesystemConnectionArgs = {
  connectionId: Scalars['Int']['input'];
};


export type MutationDeleteGoogleConnectionArgs = {
  connectionId: Scalars['Int']['input'];
};


export type MutationDeletePlexConnectionArgs = {
  connectionId: Scalars['Int']['input'];
};


export type MutationDiscoverGoogleCalendarsForConnectionArgs = {
  connectionId: Scalars['Int']['input'];
};


export type MutationDiscoverPlexLibrariesArgs = {
  baseUrl: Scalars['String']['input'];
  token: Scalars['String']['input'];
};


export type MutationSaveAiProviderArgs = {
  input: SaveAiProviderInput;
};


export type MutationSaveFilesystemConnectionArgs = {
  input: SaveFilesystemConnectionInput;
};


export type MutationSavePlexConnectionArgs = {
  input: SavePlexConnectionInput;
};


export type MutationSelectGoogleCalendarsArgs = {
  input: SelectGoogleCalendarsInput;
};


export type MutationSelectGoogleCalendarsForConnectionArgs = {
  connectionId: Scalars['Int']['input'];
  input: SelectGoogleCalendarsInput;
};


export type MutationSendPoneglyphAgentMessageArgs = {
  input: SendPoneglyphAgentMessageInput;
};


export type MutationSyncConnectorArgs = {
  name: Scalars['String']['input'];
};

export type PlexConnection = {
  __typename?: 'PlexConnection';
  baseUrl: Scalars['String']['output'];
  id: Scalars['Int']['output'];
  lastError?: Maybe<Scalars['String']['output']>;
  lastSyncedAt?: Maybe<Scalars['String']['output']>;
  libraries: Array<PlexLibraryOption>;
  name: Scalars['String']['output'];
};

export type PlexDetection = {
  __typename?: 'PlexDetection';
  baseUrl: Scalars['String']['output'];
  libraries: Array<PlexLibraryOption>;
  machineIdentifier?: Maybe<Scalars['String']['output']>;
  token?: Maybe<Scalars['String']['output']>;
};

export type PlexLibraryOption = {
  __typename?: 'PlexLibraryOption';
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type PoneglyphAgentReply = {
  __typename?: 'PoneglyphAgentReply';
  reply: Scalars['String']['output'];
  runId: Scalars['String']['output'];
  sessionId: Scalars['String']['output'];
};

export type Query = {
  __typename?: 'Query';
  agentAuditEvents: Array<AgentAuditEvent>;
  agentAuditRuns: Array<AgentAuditRun>;
  aiProviders: Array<AiProvider>;
  connectorStatuses: Array<ConnectorStatus>;
  detectLocalPlexConnection: PlexDetection;
  entities: Array<EntitySummary>;
  entity?: Maybe<EntityDetail>;
  entityKinds: Array<Scalars['String']['output']>;
  filesystemConnections: Array<FilesystemConnection>;
  gmailConnectionSummary: GmailConnectionSummary;
  gmailConnections: Array<GoogleCalendarConnection>;
  googleCalendarConnections: Array<GoogleCalendarConnection>;
  googleCalendars: Array<GoogleCalendarResource>;
  plexConnections: Array<PlexConnection>;
  schemaDefinition: KnowledgeGraphSchema;
};


export type QueryAgentAuditEventsArgs = {
  runId: Scalars['String']['input'];
};


export type QueryAgentAuditRunsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryEntitiesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryEntityArgs = {
  uri: Scalars['String']['input'];
};


export type QueryGmailConnectionSummaryArgs = {
  connectionId: Scalars['Int']['input'];
};

export type SaveAiProviderInput = {
  apiKey: Scalars['String']['input'];
  baseUrl: Scalars['String']['input'];
  defaultModel: Scalars['String']['input'];
  displayName: Scalars['String']['input'];
  enabled: Scalars['Boolean']['input'];
  providerKey: Scalars['String']['input'];
};

export type SaveFilesystemConnectionInput = {
  name: Scalars['String']['input'];
  rootPath: Scalars['String']['input'];
};

export type SavePlexConnectionInput = {
  baseUrl: Scalars['String']['input'];
  libraries: Array<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  token: Scalars['String']['input'];
};

export type SchemaField = {
  __typename?: 'SchemaField';
  domain?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  range?: Maybe<Scalars['String']['output']>;
  uri: Scalars['String']['output'];
};

export type SchemaKind = {
  __typename?: 'SchemaKind';
  name?: Maybe<Scalars['String']['output']>;
  uri: Scalars['String']['output'];
};

export type SchemaNamespace = {
  __typename?: 'SchemaNamespace';
  name?: Maybe<Scalars['String']['output']>;
  uri: Scalars['String']['output'];
};

export type SelectGoogleCalendarsInput = {
  calendarIds: Array<Scalars['String']['input']>;
};

export type SendPoneglyphAgentMessageInput = {
  message: Scalars['String']['input'];
  sessionId?: InputMaybe<Scalars['String']['input']>;
};

export type ConnectorStatusesQueryVariables = Exact<{ [key: string]: never; }>;


export type ConnectorStatusesQuery = { __typename?: 'Query', connectorStatuses: Array<{ __typename?: 'ConnectorStatus', name: string, enabled: boolean, connected: boolean, selectedResourceCount: number, lastSyncedAt?: string | null, lastError?: string | null }> };

export type GoogleCalendarsQueryVariables = Exact<{ [key: string]: never; }>;


export type GoogleCalendarsQuery = { __typename?: 'Query', googleCalendars: Array<{ __typename?: 'GoogleCalendarResource', connectionId: number, calendarId: string, summary: string, description?: string | null, timeZone?: string | null, primary: boolean, selected: boolean }> };

export type GoogleCalendarConnectionsQueryVariables = Exact<{ [key: string]: never; }>;


export type GoogleCalendarConnectionsQuery = { __typename?: 'Query', googleCalendarConnections: Array<{ __typename?: 'GoogleCalendarConnection', id: number, label: string, selectedResourceCount: number, lastSyncedAt?: string | null, lastError?: string | null, calendars: Array<{ __typename?: 'GoogleCalendarResource', connectionId: number, calendarId: string, summary: string, description?: string | null, timeZone?: string | null, primary: boolean, selected: boolean }> }> };

export type GmailConnectionsQueryVariables = Exact<{ [key: string]: never; }>;


export type GmailConnectionsQuery = { __typename?: 'Query', gmailConnections: Array<{ __typename?: 'GoogleCalendarConnection', id: number, label: string, selectedResourceCount: number, lastSyncedAt?: string | null, lastError?: string | null, calendars: Array<{ __typename?: 'GoogleCalendarResource', connectionId: number, calendarId: string, summary: string, description?: string | null, timeZone?: string | null, primary: boolean, selected: boolean }> }> };

export type GmailConnectionSummaryQueryVariables = Exact<{
  connectionId: Scalars['Int']['input'];
}>;


export type GmailConnectionSummaryQuery = { __typename?: 'Query', gmailConnectionSummary: { __typename?: 'GmailConnectionSummary', connectionId: number, sendingAddresses: Array<string>, mailboxes: Array<string>, labels: Array<string>, emails: Array<string>, lastEmailReceivedAt?: string | null } };

export type AiProvidersQueryVariables = Exact<{ [key: string]: never; }>;


export type AiProvidersQuery = { __typename?: 'Query', aiProviders: Array<{ __typename?: 'AiProvider', id: number, providerKey: string, displayName: string, baseUrl: string, defaultModel: string, enabled: boolean, hasApiKey: boolean }> };

export type AgentAuditRunsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
}>;


export type AgentAuditRunsQuery = { __typename?: 'Query', agentAuditRuns: Array<{ __typename?: 'AgentAuditRun', id: string, agentKey: string, sessionId?: string | null, source: string, status: string, inputSummary?: string | null, replySummary?: string | null, errorSummary?: string | null, startedAt: string, finishedAt?: string | null }> };

export type AgentAuditEventsQueryVariables = Exact<{
  runId: Scalars['String']['input'];
}>;


export type AgentAuditEventsQuery = { __typename?: 'Query', agentAuditEvents: Array<{ __typename?: 'AgentAuditEvent', id: string, runId: string, seq: number, eventType: string, payloadJson: string, occurredAt: string }> };

export type SaveAiProviderMutationVariables = Exact<{
  input: SaveAiProviderInput;
}>;


export type SaveAiProviderMutation = { __typename?: 'Mutation', saveAiProvider: { __typename?: 'AiProvider', id: number, providerKey: string, displayName: string, baseUrl: string, defaultModel: string, enabled: boolean, hasApiKey: boolean } };

export type DeleteAiProviderMutationVariables = Exact<{
  id: Scalars['Int']['input'];
}>;


export type DeleteAiProviderMutation = { __typename?: 'Mutation', deleteAiProvider: boolean };

export type SendPoneglyphAgentMessageMutationVariables = Exact<{
  input: SendPoneglyphAgentMessageInput;
}>;


export type SendPoneglyphAgentMessageMutation = { __typename?: 'Mutation', sendPoneglyphAgentMessage: { __typename?: 'PoneglyphAgentReply', sessionId: string, runId: string, reply: string } };

export type EntitiesQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
}>;


export type EntitiesQuery = { __typename?: 'Query', entities: Array<{ __typename?: 'EntitySummary', uri: string, namespace: string, kind: string }> };

export type EntityQueryVariables = Exact<{
  uri: Scalars['String']['input'];
}>;


export type EntityQuery = { __typename?: 'Query', entity?: { __typename?: 'EntityDetail', uri: string, namespace: string, kind: string, fields: Array<{ __typename?: 'EntityField', field: string, value: string }> } | null };

export type KnowledgeGraphSchemaQueryVariables = Exact<{ [key: string]: never; }>;


export type KnowledgeGraphSchemaQuery = { __typename?: 'Query', schemaDefinition: { __typename?: 'KnowledgeGraphSchema', namespaces: Array<{ __typename?: 'SchemaNamespace', uri: string, name?: string | null }>, kinds: Array<{ __typename?: 'SchemaKind', uri: string, name?: string | null }>, fields: Array<{ __typename?: 'SchemaField', uri: string, name?: string | null, domain?: string | null, range?: string | null }> } };

export type EntityKindsQueryVariables = Exact<{ [key: string]: never; }>;


export type EntityKindsQuery = { __typename?: 'Query', entityKinds: Array<string> };

export type PlexConnectionsQueryVariables = Exact<{ [key: string]: never; }>;


export type PlexConnectionsQuery = { __typename?: 'Query', plexConnections: Array<{ __typename?: 'PlexConnection', id: number, name: string, baseUrl: string, lastSyncedAt?: string | null, lastError?: string | null, libraries: Array<{ __typename?: 'PlexLibraryOption', id: string, name: string }> }> };

export type DetectLocalPlexConnectionQueryVariables = Exact<{ [key: string]: never; }>;


export type DetectLocalPlexConnectionQuery = { __typename?: 'Query', detectLocalPlexConnection: { __typename?: 'PlexDetection', baseUrl: string, token?: string | null, machineIdentifier?: string | null, libraries: Array<{ __typename?: 'PlexLibraryOption', id: string, name: string }> } };

export type DiscoverGoogleCalendarsMutationVariables = Exact<{ [key: string]: never; }>;


export type DiscoverGoogleCalendarsMutation = { __typename?: 'Mutation', discoverGoogleCalendars: Array<{ __typename?: 'GoogleCalendarResource', connectionId: number, calendarId: string, summary: string, description?: string | null, timeZone?: string | null, primary: boolean, selected: boolean }> };

export type FilesystemConnectionsQueryVariables = Exact<{ [key: string]: never; }>;


export type FilesystemConnectionsQuery = { __typename?: 'Query', filesystemConnections: Array<{ __typename?: 'FilesystemConnection', id: number, name: string, rootPath: string }> };

export type DiscoverGoogleCalendarsForConnectionMutationVariables = Exact<{
  connectionId: Scalars['Int']['input'];
}>;


export type DiscoverGoogleCalendarsForConnectionMutation = { __typename?: 'Mutation', discoverGoogleCalendarsForConnection: Array<{ __typename?: 'GoogleCalendarResource', connectionId: number, calendarId: string, summary: string, description?: string | null, timeZone?: string | null, primary: boolean, selected: boolean }> };

export type SelectGoogleCalendarsMutationVariables = Exact<{
  input: SelectGoogleCalendarsInput;
}>;


export type SelectGoogleCalendarsMutation = { __typename?: 'Mutation', selectGoogleCalendars: Array<{ __typename?: 'GoogleCalendarResource', connectionId: number, calendarId: string, summary: string, description?: string | null, timeZone?: string | null, primary: boolean, selected: boolean }> };

export type SelectGoogleCalendarsForConnectionMutationVariables = Exact<{
  connectionId: Scalars['Int']['input'];
  input: SelectGoogleCalendarsInput;
}>;


export type SelectGoogleCalendarsForConnectionMutation = { __typename?: 'Mutation', selectGoogleCalendarsForConnection: Array<{ __typename?: 'GoogleCalendarResource', connectionId: number, calendarId: string, summary: string, description?: string | null, timeZone?: string | null, primary: boolean, selected: boolean }> };

export type DeleteGoogleConnectionMutationVariables = Exact<{
  connectionId: Scalars['Int']['input'];
}>;


export type DeleteGoogleConnectionMutation = { __typename?: 'Mutation', deleteGoogleConnection: boolean };

export type SavePlexConnectionMutationVariables = Exact<{
  input: SavePlexConnectionInput;
}>;


export type SavePlexConnectionMutation = { __typename?: 'Mutation', savePlexConnection: { __typename?: 'PlexConnection', id: number, name: string, baseUrl: string, lastSyncedAt?: string | null, lastError?: string | null, libraries: Array<{ __typename?: 'PlexLibraryOption', id: string, name: string }> } };

export type DeletePlexConnectionMutationVariables = Exact<{
  connectionId: Scalars['Int']['input'];
}>;


export type DeletePlexConnectionMutation = { __typename?: 'Mutation', deletePlexConnection: boolean };

export type SaveFilesystemConnectionMutationVariables = Exact<{
  input: SaveFilesystemConnectionInput;
}>;


export type SaveFilesystemConnectionMutation = { __typename?: 'Mutation', saveFilesystemConnection: { __typename?: 'FilesystemConnection', id: number, name: string, rootPath: string } };

export type DeleteFilesystemConnectionMutationVariables = Exact<{
  connectionId: Scalars['Int']['input'];
}>;


export type DeleteFilesystemConnectionMutation = { __typename?: 'Mutation', deleteFilesystemConnection: boolean };

export type DiscoverPlexLibrariesMutationVariables = Exact<{
  baseUrl: Scalars['String']['input'];
  token: Scalars['String']['input'];
}>;


export type DiscoverPlexLibrariesMutation = { __typename?: 'Mutation', discoverPlexLibraries: Array<{ __typename?: 'PlexLibraryOption', id: string, name: string }> };

export type SyncConnectorMutationVariables = Exact<{
  name: Scalars['String']['input'];
}>;


export type SyncConnectorMutation = { __typename?: 'Mutation', syncConnector: { __typename?: 'ConnectorSyncResult', name: string, synced: boolean, message: string } };


export const ConnectorStatusesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ConnectorStatuses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectorStatuses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"enabled"}},{"kind":"Field","name":{"kind":"Name","value":"connected"}},{"kind":"Field","name":{"kind":"Name","value":"selectedResourceCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastSyncedAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastError"}}]}}]}}]} as unknown as DocumentNode<ConnectorStatusesQuery, ConnectorStatusesQueryVariables>;
export const GoogleCalendarsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GoogleCalendars"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"googleCalendars"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"calendarId"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"timeZone"}},{"kind":"Field","name":{"kind":"Name","value":"primary"}},{"kind":"Field","name":{"kind":"Name","value":"selected"}}]}}]}}]} as unknown as DocumentNode<GoogleCalendarsQuery, GoogleCalendarsQueryVariables>;
export const GoogleCalendarConnectionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GoogleCalendarConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"googleCalendarConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"selectedResourceCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastSyncedAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastError"}},{"kind":"Field","name":{"kind":"Name","value":"calendars"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"calendarId"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"timeZone"}},{"kind":"Field","name":{"kind":"Name","value":"primary"}},{"kind":"Field","name":{"kind":"Name","value":"selected"}}]}}]}}]}}]} as unknown as DocumentNode<GoogleCalendarConnectionsQuery, GoogleCalendarConnectionsQueryVariables>;
export const GmailConnectionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GmailConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"gmailConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"label"}},{"kind":"Field","name":{"kind":"Name","value":"selectedResourceCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastSyncedAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastError"}},{"kind":"Field","name":{"kind":"Name","value":"calendars"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"calendarId"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"timeZone"}},{"kind":"Field","name":{"kind":"Name","value":"primary"}},{"kind":"Field","name":{"kind":"Name","value":"selected"}}]}}]}}]}}]} as unknown as DocumentNode<GmailConnectionsQuery, GmailConnectionsQueryVariables>;
export const GmailConnectionSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GmailConnectionSummary"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"gmailConnectionSummary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"sendingAddresses"}},{"kind":"Field","name":{"kind":"Name","value":"mailboxes"}},{"kind":"Field","name":{"kind":"Name","value":"labels"}},{"kind":"Field","name":{"kind":"Name","value":"emails"}},{"kind":"Field","name":{"kind":"Name","value":"lastEmailReceivedAt"}}]}}]}}]} as unknown as DocumentNode<GmailConnectionSummaryQuery, GmailConnectionSummaryQueryVariables>;
export const AiProvidersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AiProviders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"aiProviders"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"providerKey"}},{"kind":"Field","name":{"kind":"Name","value":"displayName"}},{"kind":"Field","name":{"kind":"Name","value":"baseUrl"}},{"kind":"Field","name":{"kind":"Name","value":"defaultModel"}},{"kind":"Field","name":{"kind":"Name","value":"enabled"}},{"kind":"Field","name":{"kind":"Name","value":"hasApiKey"}}]}}]}}]} as unknown as DocumentNode<AiProvidersQuery, AiProvidersQueryVariables>;
export const AgentAuditRunsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AgentAuditRuns"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"offset"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"agentAuditRuns"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"offset"},"value":{"kind":"Variable","name":{"kind":"Name","value":"offset"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"agentKey"}},{"kind":"Field","name":{"kind":"Name","value":"sessionId"}},{"kind":"Field","name":{"kind":"Name","value":"source"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"inputSummary"}},{"kind":"Field","name":{"kind":"Name","value":"replySummary"}},{"kind":"Field","name":{"kind":"Name","value":"errorSummary"}},{"kind":"Field","name":{"kind":"Name","value":"startedAt"}},{"kind":"Field","name":{"kind":"Name","value":"finishedAt"}}]}}]}}]} as unknown as DocumentNode<AgentAuditRunsQuery, AgentAuditRunsQueryVariables>;
export const AgentAuditEventsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AgentAuditEvents"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"runId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"agentAuditEvents"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"runId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"runId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"runId"}},{"kind":"Field","name":{"kind":"Name","value":"seq"}},{"kind":"Field","name":{"kind":"Name","value":"eventType"}},{"kind":"Field","name":{"kind":"Name","value":"payloadJson"}},{"kind":"Field","name":{"kind":"Name","value":"occurredAt"}}]}}]}}]} as unknown as DocumentNode<AgentAuditEventsQuery, AgentAuditEventsQueryVariables>;
export const SaveAiProviderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SaveAiProvider"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SaveAiProviderInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"saveAiProvider"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"providerKey"}},{"kind":"Field","name":{"kind":"Name","value":"displayName"}},{"kind":"Field","name":{"kind":"Name","value":"baseUrl"}},{"kind":"Field","name":{"kind":"Name","value":"defaultModel"}},{"kind":"Field","name":{"kind":"Name","value":"enabled"}},{"kind":"Field","name":{"kind":"Name","value":"hasApiKey"}}]}}]}}]} as unknown as DocumentNode<SaveAiProviderMutation, SaveAiProviderMutationVariables>;
export const DeleteAiProviderDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteAiProvider"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteAiProvider"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<DeleteAiProviderMutation, DeleteAiProviderMutationVariables>;
export const SendPoneglyphAgentMessageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SendPoneglyphAgentMessage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SendPoneglyphAgentMessageInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sendPoneglyphAgentMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sessionId"}},{"kind":"Field","name":{"kind":"Name","value":"runId"}},{"kind":"Field","name":{"kind":"Name","value":"reply"}}]}}]}}]} as unknown as DocumentNode<SendPoneglyphAgentMessageMutation, SendPoneglyphAgentMessageMutationVariables>;
export const EntitiesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Entities"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"offset"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"entities"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"offset"},"value":{"kind":"Variable","name":{"kind":"Name","value":"offset"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"uri"}},{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}}]}}]}}]} as unknown as DocumentNode<EntitiesQuery, EntitiesQueryVariables>;
export const EntityDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Entity"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"uri"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"entity"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"uri"},"value":{"kind":"Variable","name":{"kind":"Name","value":"uri"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"uri"}},{"kind":"Field","name":{"kind":"Name","value":"namespace"}},{"kind":"Field","name":{"kind":"Name","value":"kind"}},{"kind":"Field","name":{"kind":"Name","value":"fields"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]}}]} as unknown as DocumentNode<EntityQuery, EntityQueryVariables>;
export const KnowledgeGraphSchemaDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"KnowledgeGraphSchema"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"schemaDefinition"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"namespaces"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"uri"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"kinds"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"uri"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"fields"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"uri"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"domain"}},{"kind":"Field","name":{"kind":"Name","value":"range"}}]}}]}}]}}]} as unknown as DocumentNode<KnowledgeGraphSchemaQuery, KnowledgeGraphSchemaQueryVariables>;
export const EntityKindsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"EntityKinds"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"entityKinds"}}]}}]} as unknown as DocumentNode<EntityKindsQuery, EntityKindsQueryVariables>;
export const PlexConnectionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"PlexConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"plexConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"baseUrl"}},{"kind":"Field","name":{"kind":"Name","value":"libraries"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"lastSyncedAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastError"}}]}}]}}]} as unknown as DocumentNode<PlexConnectionsQuery, PlexConnectionsQueryVariables>;
export const DetectLocalPlexConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"DetectLocalPlexConnection"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"detectLocalPlexConnection"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"baseUrl"}},{"kind":"Field","name":{"kind":"Name","value":"token"}},{"kind":"Field","name":{"kind":"Name","value":"machineIdentifier"}},{"kind":"Field","name":{"kind":"Name","value":"libraries"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]} as unknown as DocumentNode<DetectLocalPlexConnectionQuery, DetectLocalPlexConnectionQueryVariables>;
export const DiscoverGoogleCalendarsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DiscoverGoogleCalendars"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"discoverGoogleCalendars"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"calendarId"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"timeZone"}},{"kind":"Field","name":{"kind":"Name","value":"primary"}},{"kind":"Field","name":{"kind":"Name","value":"selected"}}]}}]}}]} as unknown as DocumentNode<DiscoverGoogleCalendarsMutation, DiscoverGoogleCalendarsMutationVariables>;
export const FilesystemConnectionsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FilesystemConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"filesystemConnections"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"rootPath"}}]}}]}}]} as unknown as DocumentNode<FilesystemConnectionsQuery, FilesystemConnectionsQueryVariables>;
export const DiscoverGoogleCalendarsForConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DiscoverGoogleCalendarsForConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"discoverGoogleCalendarsForConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"calendarId"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"timeZone"}},{"kind":"Field","name":{"kind":"Name","value":"primary"}},{"kind":"Field","name":{"kind":"Name","value":"selected"}}]}}]}}]} as unknown as DocumentNode<DiscoverGoogleCalendarsForConnectionMutation, DiscoverGoogleCalendarsForConnectionMutationVariables>;
export const SelectGoogleCalendarsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SelectGoogleCalendars"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SelectGoogleCalendarsInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"selectGoogleCalendars"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"calendarId"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"timeZone"}},{"kind":"Field","name":{"kind":"Name","value":"primary"}},{"kind":"Field","name":{"kind":"Name","value":"selected"}}]}}]}}]} as unknown as DocumentNode<SelectGoogleCalendarsMutation, SelectGoogleCalendarsMutationVariables>;
export const SelectGoogleCalendarsForConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SelectGoogleCalendarsForConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SelectGoogleCalendarsInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"selectGoogleCalendarsForConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"connectionId"}},{"kind":"Field","name":{"kind":"Name","value":"calendarId"}},{"kind":"Field","name":{"kind":"Name","value":"summary"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"timeZone"}},{"kind":"Field","name":{"kind":"Name","value":"primary"}},{"kind":"Field","name":{"kind":"Name","value":"selected"}}]}}]}}]} as unknown as DocumentNode<SelectGoogleCalendarsForConnectionMutation, SelectGoogleCalendarsForConnectionMutationVariables>;
export const DeleteGoogleConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteGoogleConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteGoogleConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}}]}]}}]} as unknown as DocumentNode<DeleteGoogleConnectionMutation, DeleteGoogleConnectionMutationVariables>;
export const SavePlexConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SavePlexConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SavePlexConnectionInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"savePlexConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"baseUrl"}},{"kind":"Field","name":{"kind":"Name","value":"libraries"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"lastSyncedAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastError"}}]}}]}}]} as unknown as DocumentNode<SavePlexConnectionMutation, SavePlexConnectionMutationVariables>;
export const DeletePlexConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeletePlexConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deletePlexConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}}]}]}}]} as unknown as DocumentNode<DeletePlexConnectionMutation, DeletePlexConnectionMutationVariables>;
export const SaveFilesystemConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SaveFilesystemConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SaveFilesystemConnectionInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"saveFilesystemConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"rootPath"}}]}}]}}]} as unknown as DocumentNode<SaveFilesystemConnectionMutation, SaveFilesystemConnectionMutationVariables>;
export const DeleteFilesystemConnectionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteFilesystemConnection"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteFilesystemConnection"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"connectionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"connectionId"}}}]}]}}]} as unknown as DocumentNode<DeleteFilesystemConnectionMutation, DeleteFilesystemConnectionMutationVariables>;
export const DiscoverPlexLibrariesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DiscoverPlexLibraries"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"baseUrl"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"token"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"discoverPlexLibraries"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"baseUrl"},"value":{"kind":"Variable","name":{"kind":"Name","value":"baseUrl"}}},{"kind":"Argument","name":{"kind":"Name","value":"token"},"value":{"kind":"Variable","name":{"kind":"Name","value":"token"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<DiscoverPlexLibrariesMutation, DiscoverPlexLibrariesMutationVariables>;
export const SyncConnectorDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SyncConnector"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"name"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"syncConnector"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"name"},"value":{"kind":"Variable","name":{"kind":"Name","value":"name"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"synced"}},{"kind":"Field","name":{"kind":"Name","value":"message"}}]}}]}}]} as unknown as DocumentNode<SyncConnectorMutation, SyncConnectorMutationVariables>;