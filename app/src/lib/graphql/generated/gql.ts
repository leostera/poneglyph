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
    "\n  query PlexConnections {\n    plexConnections {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n": typeof types.PlexConnectionsDocument,
    "\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n    }\n  }\n": typeof types.DetectLocalPlexConnectionDocument,
    "\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.DiscoverGoogleCalendarsDocument,
    "\n  mutation DiscoverGoogleCalendarsForConnection($connectionId: Int!) {\n    discoverGoogleCalendarsForConnection(connectionId: $connectionId) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.DiscoverGoogleCalendarsForConnectionDocument,
    "\n  mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {\n    selectGoogleCalendars(input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.SelectGoogleCalendarsDocument,
    "\n  mutation SelectGoogleCalendarsForConnection(\n    $connectionId: Int!\n    $input: SelectGoogleCalendarsInput!\n  ) {\n    selectGoogleCalendarsForConnection(connectionId: $connectionId, input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": typeof types.SelectGoogleCalendarsForConnectionDocument,
    "\n  mutation DeleteGoogleConnection($connectionId: Int!) {\n    deleteGoogleConnection(connectionId: $connectionId)\n  }\n": typeof types.DeleteGoogleConnectionDocument,
    "\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n": typeof types.SavePlexConnectionDocument,
    "\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n": typeof types.DeletePlexConnectionDocument,
    "\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token)\n  }\n": typeof types.DiscoverPlexLibrariesDocument,
    "\n  mutation SyncConnector($name: String!) {\n    syncConnector(name: $name) {\n      name\n      synced\n      message\n    }\n  }\n": typeof types.SyncConnectorDocument,
};
const documents: Documents = {
    "\n  query ConnectorStatuses {\n    connectorStatuses {\n      name\n      enabled\n      connected\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n    }\n  }\n": types.ConnectorStatusesDocument,
    "\n  query GoogleCalendars {\n    googleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.GoogleCalendarsDocument,
    "\n  query GoogleCalendarConnections {\n    googleCalendarConnections {\n      id\n      label\n      selectedResourceCount\n      lastSyncedAt\n      lastError\n      calendars {\n        connectionId\n        calendarId\n        summary\n        description\n        timeZone\n        primary\n        selected\n      }\n    }\n  }\n": types.GoogleCalendarConnectionsDocument,
    "\n  query PlexConnections {\n    plexConnections {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n": types.PlexConnectionsDocument,
    "\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n    }\n  }\n": types.DetectLocalPlexConnectionDocument,
    "\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.DiscoverGoogleCalendarsDocument,
    "\n  mutation DiscoverGoogleCalendarsForConnection($connectionId: Int!) {\n    discoverGoogleCalendarsForConnection(connectionId: $connectionId) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.DiscoverGoogleCalendarsForConnectionDocument,
    "\n  mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {\n    selectGoogleCalendars(input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.SelectGoogleCalendarsDocument,
    "\n  mutation SelectGoogleCalendarsForConnection(\n    $connectionId: Int!\n    $input: SelectGoogleCalendarsInput!\n  ) {\n    selectGoogleCalendarsForConnection(connectionId: $connectionId, input: $input) {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n": types.SelectGoogleCalendarsForConnectionDocument,
    "\n  mutation DeleteGoogleConnection($connectionId: Int!) {\n    deleteGoogleConnection(connectionId: $connectionId)\n  }\n": types.DeleteGoogleConnectionDocument,
    "\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n": types.SavePlexConnectionDocument,
    "\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n": types.DeletePlexConnectionDocument,
    "\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token)\n  }\n": types.DiscoverPlexLibrariesDocument,
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
export function graphql(source: "\n  query PlexConnections {\n    plexConnections {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n"): (typeof documents)["\n  query PlexConnections {\n    plexConnections {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n    }\n  }\n"): (typeof documents)["\n  query DetectLocalPlexConnection {\n    detectLocalPlexConnection {\n      baseUrl\n      token\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"): (typeof documents)["\n  mutation DiscoverGoogleCalendars {\n    discoverGoogleCalendars {\n      connectionId\n      calendarId\n      summary\n      description\n      timeZone\n      primary\n      selected\n    }\n  }\n"];
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
export function graphql(source: "\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n"): (typeof documents)["\n  mutation SavePlexConnection($input: SavePlexConnectionInput!) {\n    savePlexConnection(input: $input) {\n      id\n      baseUrl\n      libraries\n      lastSyncedAt\n      lastError\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n"): (typeof documents)["\n  mutation DeletePlexConnection($connectionId: Int!) {\n    deletePlexConnection(connectionId: $connectionId)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token)\n  }\n"): (typeof documents)["\n  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {\n    discoverPlexLibraries(baseUrl: $baseUrl, token: $token)\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SyncConnector($name: String!) {\n    syncConnector(name: $name) {\n      name\n      synced\n      message\n    }\n  }\n"): (typeof documents)["\n  mutation SyncConnector($name: String!) {\n    syncConnector(name: $name) {\n      name\n      synced\n      message\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;