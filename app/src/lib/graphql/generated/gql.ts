/* eslint-disable */
import * as types from './graphql';
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';

/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  query ConnectorStatuses {\n    connectorStatuses {\n      name\n      enabled\n      connected\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n    }\n  }\n": typeof types.ConnectorStatusesDocument,
    "\n  query GoogleCalendars {\n    googleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.GoogleCalendarsDocument,
    "\n  query GoogleCalendarConnections {\n    googleCalendarConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n": typeof types.GoogleCalendarConnectionsDocument,
    "\n  query GmailConnections {\n    gmailConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n": typeof types.GmailConnectionsDocument,
    "\n  query GmailConnectionSummary($connectionId: Int!) {\n    gmailConnectionSummary(connectionId: $connectionId) {\n      connectionId\n      sendingAddresses\n      mailboxes\n      labels\n      emails\n      lastEmailReceivedAt\n    }\n  }\n": typeof types.GmailConnectionSummaryDocument,
    "\n  query AiProviders {\n    aiProviders {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n": typeof types.AiProvidersDocument,
    "\n  query AgentAuditRuns($limit: Int, $offset: Int) {\n    agentAuditRuns(limit: $limit, offset: $offset) {\n      id\n      agentKey\n      sessionId\n      source\n      status\n      inputSummary\n      replySummary\n      errorSummary\n      startedAt\n      finishedAt\n    }\n  }\n": typeof types.AgentAuditRunsDocument,
    "\n  query AgentAuditEvents($runId: String!) {\n    agentAuditEvents(runId: $runId) {\n      id\n      runId\n      seq\n      eventType\n      payloadJson\n      occurredAt\n    }\n  }\n": typeof types.AgentAuditEventsDocument,
    "\n  mutation SaveAiProvider($input: SaveAiProviderInput!) {\n    saveAiProvider(input: $input) {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n": typeof types.SaveAiProviderDocument,
    "\n  mutation DeleteAiProvider($id: Int!) {\n    deleteAiProvider(id: $id)\n  }\n": typeof types.DeleteAiProviderDocument,
    "\n  mutation SendPoneglyphAgentMessage($input: SendPoneglyphAgentMessageInput!) {\n    sendPoneglyphAgentMessage(input: $input) {\n      sessionId\n      runId\n      reply\n    }\n  }\n": typeof types.SendPoneglyphAgentMessageDocument,
    "\n  query Entities($limit: Int, $offset: Int) {\n    entities(limit: $limit, offset: $offset) {\n      uri\n      namespace\n      kind\n    }\n  }\n": typeof types.EntitiesDocument,
    "\n  query Entity($uri: String!) {\n    entity(uri: $uri) {\n      uri\n      namespace\n      kind\n      fields {\n        field\n        value\n      }\n    }\n  }\n": typeof types.EntityDocument,
    "\n  query KnowledgeGraphSchema {\n    schemaDefinition {\n      namespaces {\n        uri\n        name\n      }\n      kinds {\n        uri\n        name\n      }\n      fields {\n        uri\n        name\n        domain\n        range\n      }\n    }\n  }\n": typeof types.KnowledgeGraphSchemaDocument,
    "\n  query EntityKinds {\n    entityKinds\n  }\n": typeof types.EntityKindsDocument,
    "\n  query PlexConnections {\n    plexConnections {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n": typeof types.PlexConnectionsDocument,
    "\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n      machineIdentifier\n      libraries {\n        id\n        name\n      }\n    }\n  }\n": typeof types.DetectLocalPlexConnectionDocument,
    "\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.DiscoverGoogleCalendarsDocument,
    "\n  query FilesystemConnections {\n    filesystemConnections {\n      id\n      name\n      rootPath\n    }\n  }\n": typeof types.FilesystemConnectionsDocument,
    "\n  mutation DiscoverGoogleCalendarsForConnection($connectionId: Int!) {\n    discoverGoogleCalendarsForConnection(connectionId: $connectionId) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.DiscoverGoogleCalendarsForConnectionDocument,
    "\n  mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {\n    selectGoogleCalendars(input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.SelectGoogleCalendarsDocument,
    "\n  mutation SelectGoogleCalendarsForConnection(\n    $connectionId: Int!\n    $input: SelectGoogleCalendarsInput!\n  ) {\n    selectGoogleCalendarsForConnection(connectionId: $connectionId, input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.SelectGoogleCalendarsForConnectionDocument,
    "\n  mutation DeleteGoogleConnection($connectionId: Int!) {\n    deleteGoogleConnection(connectionId: $connectionId)\n  }\n": typeof types.DeleteGoogleConnectionDocument,
    "\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n": typeof types.SavePlexConnectionDocument,
    "\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n": typeof types.DeletePlexConnectionDocument,
    "\n  mutation SaveFilesystemConnection($input: SaveFilesystemConnectionInput!) {\n    saveFilesystemConnection(input: $input) {\n      id\n      name\n      rootPath\n    }\n  }\n": typeof types.SaveFilesystemConnectionDocument,
    "\n  mutation DeleteFilesystemConnection($connectionId: Int!) {\n    deleteFilesystemConnection(connectionId: $connectionId)\n  }\n": typeof types.DeleteFilesystemConnectionDocument,
    "\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token) {\n      id\n      name\n    }\n  }\n": typeof types.DiscoverPlexLibrariesDocument,
    "\n  mutation SyncConnector($name: String!) {\n    syncConnector(name: $name) {\n      name\n      synced\n      message\n    }\n  }\n": typeof types.SyncConnectorDocument,
};
const documents: Documents = {
    "\n  query ConnectorStatuses {\n    connectorStatuses {\n      name\n      enabled\n      connected\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n    }\n  }\n": types.ConnectorStatusesDocument,
    "\n  query GoogleCalendars {\n    googleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.GoogleCalendarsDocument,
    "\n  query GoogleCalendarConnections {\n    googleCalendarConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n": types.GoogleCalendarConnectionsDocument,
    "\n  query GmailConnections {\n    gmailConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n": types.GmailConnectionsDocument,
    "\n  query GmailConnectionSummary($connectionId: Int!) {\n    gmailConnectionSummary(connectionId: $connectionId) {\n      connectionId\n      sendingAddresses\n      mailboxes\n      labels\n      emails\n      lastEmailReceivedAt\n    }\n  }\n": types.GmailConnectionSummaryDocument,
    "\n  query AiProviders {\n    aiProviders {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n": types.AiProvidersDocument,
    "\n  query AgentAuditRuns($limit: Int, $offset: Int) {\n    agentAuditRuns(limit: $limit, offset: $offset) {\n      id\n      agentKey\n      sessionId\n      source\n      status\n      inputSummary\n      replySummary\n      errorSummary\n      startedAt\n      finishedAt\n    }\n  }\n": types.AgentAuditRunsDocument,
    "\n  query AgentAuditEvents($runId: String!) {\n    agentAuditEvents(runId: $runId) {\n      id\n      runId\n      seq\n      eventType\n      payloadJson\n      occurredAt\n    }\n  }\n": types.AgentAuditEventsDocument,
    "\n  mutation SaveAiProvider($input: SaveAiProviderInput!) {\n    saveAiProvider(input: $input) {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n": types.SaveAiProviderDocument,
    "\n  mutation DeleteAiProvider($id: Int!) {\n    deleteAiProvider(id: $id)\n  }\n": types.DeleteAiProviderDocument,
    "\n  mutation SendPoneglyphAgentMessage($input: SendPoneglyphAgentMessageInput!) {\n    sendPoneglyphAgentMessage(input: $input) {\n      sessionId\n      runId\n      reply\n    }\n  }\n": types.SendPoneglyphAgentMessageDocument,
    "\n  query Entities($limit: Int, $offset: Int) {\n    entities(limit: $limit, offset: $offset) {\n      uri\n      namespace\n      kind\n    }\n  }\n": types.EntitiesDocument,
    "\n  query Entity($uri: String!) {\n    entity(uri: $uri) {\n      uri\n      namespace\n      kind\n      fields {\n        field\n        value\n      }\n    }\n  }\n": types.EntityDocument,
    "\n  query KnowledgeGraphSchema {\n    schemaDefinition {\n      namespaces {\n        uri\n        name\n      }\n      kinds {\n        uri\n        name\n      }\n      fields {\n        uri\n        name\n        domain\n        range\n      }\n    }\n  }\n": types.KnowledgeGraphSchemaDocument,
    "\n  query EntityKinds {\n    entityKinds\n  }\n": types.EntityKindsDocument,
    "\n  query PlexConnections {\n    plexConnections {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n": types.PlexConnectionsDocument,
    "\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n      machineIdentifier\n      libraries {\n        id\n        name\n      }\n    }\n  }\n": types.DetectLocalPlexConnectionDocument,
    "\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.DiscoverGoogleCalendarsDocument,
    "\n  query FilesystemConnections {\n    filesystemConnections {\n      id\n      name\n      rootPath\n    }\n  }\n": types.FilesystemConnectionsDocument,
    "\n  mutation DiscoverGoogleCalendarsForConnection($connectionId: Int!) {\n    discoverGoogleCalendarsForConnection(connectionId: $connectionId) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.DiscoverGoogleCalendarsForConnectionDocument,
    "\n  mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {\n    selectGoogleCalendars(input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.SelectGoogleCalendarsDocument,
    "\n  mutation SelectGoogleCalendarsForConnection(\n    $connectionId: Int!\n    $input: SelectGoogleCalendarsInput!\n  ) {\n    selectGoogleCalendarsForConnection(connectionId: $connectionId, input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.SelectGoogleCalendarsForConnectionDocument,
    "\n  mutation DeleteGoogleConnection($connectionId: Int!) {\n    deleteGoogleConnection(connectionId: $connectionId)\n  }\n": types.DeleteGoogleConnectionDocument,
    "\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n": types.SavePlexConnectionDocument,
    "\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n": types.DeletePlexConnectionDocument,
    "\n  mutation SaveFilesystemConnection($input: SaveFilesystemConnectionInput!) {\n    saveFilesystemConnection(input: $input) {\n      id\n      name\n      rootPath\n    }\n  }\n": types.SaveFilesystemConnectionDocument,
    "\n  mutation DeleteFilesystemConnection($connectionId: Int!) {\n    deleteFilesystemConnection(connectionId: $connectionId)\n  }\n": types.DeleteFilesystemConnectionDocument,
    "\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token) {\n      id\n      name\n    }\n  }\n": types.DiscoverPlexLibrariesDocument,
    "\n  mutation SyncConnector($name: String!) {\n    syncConnector(name: $name) {\n      name\n      synced\n      message\n    }\n  }\n": types.SyncConnectorDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 *
 *
 * @example
 * ```ts
 * const query = graphql(`query GetUser($id: ID!) { user(id: $id) { name } }`);
 * ```
 *
 * The query argument is unknown!
 * Please regenerate the types.
 */
export function graphql(source: string): unknown;

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ConnectorStatuses {\n    connectorStatuses {\n      name\n      enabled\n      connected\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n    }\n  }\n"): (typeof documents)["\n  query ConnectorStatuses {\n    connectorStatuses {\n      name\n      enabled\n      connected\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GoogleCalendars {\n    googleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"): (typeof documents)["\n  query GoogleCalendars {\n    googleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GoogleCalendarConnections {\n    googleCalendarConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n"): (typeof documents)["\n  query GoogleCalendarConnections {\n    googleCalendarConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GmailConnections {\n    gmailConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n"): (typeof documents)["\n  query GmailConnections {\n    gmailConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GmailConnectionSummary($connectionId: Int!) {\n    gmailConnectionSummary(connectionId: $connectionId) {\n      connectionId\n      sendingAddresses\n      mailboxes\n      labels\n      emails\n      lastEmailReceivedAt\n    }\n  }\n"): (typeof documents)["\n  query GmailConnectionSummary($connectionId: Int!) {\n    gmailConnectionSummary(connectionId: $connectionId) {\n      connectionId\n      sendingAddresses\n      mailboxes\n      labels\n      emails\n      lastEmailReceivedAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query AiProviders {\n    aiProviders {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n"): (typeof documents)["\n  query AiProviders {\n    aiProviders {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query AgentAuditRuns($limit: Int, $offset: Int) {\n    agentAuditRuns(limit: $limit, offset: $offset) {\n      id\n      agentKey\n      sessionId\n      source\n      status\n      inputSummary\n      replySummary\n      errorSummary\n      startedAt\n      finishedAt\n    }\n  }\n"): (typeof documents)["\n  query AgentAuditRuns($limit: Int, $offset: Int) {\n    agentAuditRuns(limit: $limit, offset: $offset) {\n      id\n      agentKey\n      sessionId\n      source\n      status\n      inputSummary\n      replySummary\n      errorSummary\n      startedAt\n      finishedAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query AgentAuditEvents($runId: String!) {\n    agentAuditEvents(runId: $runId) {\n      id\n      runId\n      seq\n      eventType\n      payloadJson\n      occurredAt\n    }\n  }\n"): (typeof documents)["\n  query AgentAuditEvents($runId: String!) {\n    agentAuditEvents(runId: $runId) {\n      id\n      runId\n      seq\n      eventType\n      payloadJson\n      occurredAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SaveAiProvider($input: SaveAiProviderInput!) {\n    saveAiProvider(input: $input) {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n"): (typeof documents)["\n  mutation SaveAiProvider($input: SaveAiProviderInput!) {\n    saveAiProvider(input: $input) {\n      id\n      providerKey\n      displayName\n      baseUrl\n      defaultModel\n      enabled\n      hasApiKey\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeleteAiProvider($id: Int!) {\n    deleteAiProvider(id: $id)\n  }\n"): (typeof documents)["\n  mutation DeleteAiProvider($id: Int!) {\n    deleteAiProvider(id: $id)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SendPoneglyphAgentMessage($input: SendPoneglyphAgentMessageInput!) {\n    sendPoneglyphAgentMessage(input: $input) {\n      sessionId\n      runId\n      reply\n    }\n  }\n"): (typeof documents)["\n  mutation SendPoneglyphAgentMessage($input: SendPoneglyphAgentMessageInput!) {\n    sendPoneglyphAgentMessage(input: $input) {\n      sessionId\n      runId\n      reply\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Entities($limit: Int, $offset: Int) {\n    entities(limit: $limit, offset: $offset) {\n      uri\n      namespace\n      kind\n    }\n  }\n"): (typeof documents)["\n  query Entities($limit: Int, $offset: Int) {\n    entities(limit: $limit, offset: $offset) {\n      uri\n      namespace\n      kind\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Entity($uri: String!) {\n    entity(uri: $uri) {\n      uri\n      namespace\n      kind\n      fields {\n        field\n        value\n      }\n    }\n  }\n"): (typeof documents)["\n  query Entity($uri: String!) {\n    entity(uri: $uri) {\n      uri\n      namespace\n      kind\n      fields {\n        field\n        value\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query KnowledgeGraphSchema {\n    schemaDefinition {\n      namespaces {\n        uri\n        name\n      }\n      kinds {\n        uri\n        name\n      }\n      fields {\n        uri\n        name\n        domain\n        range\n      }\n    }\n  }\n"): (typeof documents)["\n  query KnowledgeGraphSchema {\n    schemaDefinition {\n      namespaces {\n        uri\n        name\n      }\n      kinds {\n        uri\n        name\n      }\n      fields {\n        uri\n        name\n        domain\n        range\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query EntityKinds {\n    entityKinds\n  }\n"): (typeof documents)["\n  query EntityKinds {\n    entityKinds\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query PlexConnections {\n    plexConnections {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n"): (typeof documents)["\n  query PlexConnections {\n    plexConnections {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n      machineIdentifier\n      libraries {\n        id\n        name\n      }\n    }\n  }\n"): (typeof documents)["\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n      machineIdentifier\n      libraries {\n        id\n        name\n      }\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"): (typeof documents)["\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query FilesystemConnections {\n    filesystemConnections {\n      id\n      name\n      rootPath\n    }\n  }\n"): (typeof documents)["\n  query FilesystemConnections {\n    filesystemConnections {\n      id\n      name\n      rootPath\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DiscoverGoogleCalendarsForConnection($connectionId: Int!) {\n    discoverGoogleCalendarsForConnection(connectionId: $connectionId) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"): (typeof documents)["\n  mutation DiscoverGoogleCalendarsForConnection($connectionId: Int!) {\n    discoverGoogleCalendarsForConnection(connectionId: $connectionId) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {\n    selectGoogleCalendars(input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"): (typeof documents)["\n  mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {\n    selectGoogleCalendars(input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SelectGoogleCalendarsForConnection(\n    $connectionId: Int!\n    $input: SelectGoogleCalendarsInput!\n  ) {\n    selectGoogleCalendarsForConnection(connectionId: $connectionId, input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"): (typeof documents)["\n  mutation SelectGoogleCalendarsForConnection(\n    $connectionId: Int!\n    $input: SelectGoogleCalendarsInput!\n  ) {\n    selectGoogleCalendarsForConnection(connectionId: $connectionId, input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeleteGoogleConnection($connectionId: Int!) {\n    deleteGoogleConnection(connectionId: $connectionId)\n  }\n"): (typeof documents)["\n  mutation DeleteGoogleConnection($connectionId: Int!) {\n    deleteGoogleConnection(connectionId: $connectionId)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n"): (typeof documents)["\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      name\n      baseUrl\n      libraries {\n        id\n        name\n      }\n      lastSyncedAt\n      lastError\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n"): (typeof documents)["\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SaveFilesystemConnection($input: SaveFilesystemConnectionInput!) {\n    saveFilesystemConnection(input: $input) {\n      id\n      name\n      rootPath\n    }\n  }\n"): (typeof documents)["\n  mutation SaveFilesystemConnection($input: SaveFilesystemConnectionInput!) {\n    saveFilesystemConnection(input: $input) {\n      id\n      name\n      rootPath\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeleteFilesystemConnection($connectionId: Int!) {\n    deleteFilesystemConnection(connectionId: $connectionId)\n  }\n"): (typeof documents)["\n  mutation DeleteFilesystemConnection($connectionId: Int!) {\n    deleteFilesystemConnection(connectionId: $connectionId)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token) {\n      id\n      name\n    }\n  }\n"): (typeof documents)["\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token) {\n      id\n      name\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SyncConnector($name: String!) {\n    syncConnector(name: $name) {\n      name\n      synced\n      message\n    }\n  }\n"): (typeof documents)["\n  mutation SyncConnector($name: String!) {\n    syncConnector(name: $name) {\n      name\n      synced\n      message\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;