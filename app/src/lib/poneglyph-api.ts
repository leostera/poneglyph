import {
  ConnectorStatusesDocument,
  DeleteFilesystemConnectionDocument,
  DeleteGoogleConnectionDocument,
  DeletePlexConnectionDocument,
  DetectLocalPlexConnectionDocument,
  DiscoverGoogleCalendarsDocument,
  DiscoverGoogleCalendarsForConnectionDocument,
  DiscoverPlexLibrariesDocument,
  EntitiesDocument,
  EntityDocument,
  FilesystemConnectionsDocument,
  GmailConnectionSummaryDocument,
  GmailConnectionsDocument,
  GoogleCalendarConnectionsDocument,
  GoogleCalendarsDocument,
  KnowledgeGraphSchemaDocument,
  PlexConnectionsDocument,
  SaveFilesystemConnectionDocument,
  SavePlexConnectionDocument,
  SelectGoogleCalendarsDocument,
  SelectGoogleCalendarsForConnectionDocument,
  SyncConnectorDocument,
} from "@/lib/graphql/documents";
import type { ResultOf, VariablesOf } from "@graphql-typed-document-node/core";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { print } from "graphql";

type GraphqlEnvelope<TData> = {
  data?: TData;
  errors?: Array<{ message?: string }>;
};

const DEFAULT_LOCAL_API_BASE_URL = "http://127.0.0.1:8787";
const CONNECTOR_NAMES = ["plex", "gcal", "gmail", "filesystem"] as const;

export type ConnectorName = (typeof CONNECTOR_NAMES)[number];
export type ConnectorStatus = ResultOf<
  typeof ConnectorStatusesDocument
>["connectorStatuses"][number];
export type GoogleCalendarResource = ResultOf<
  typeof GoogleCalendarsDocument
>["googleCalendars"][number];
export type GoogleCalendarConnection = ResultOf<
  typeof GoogleCalendarConnectionsDocument
>["googleCalendarConnections"][number];
export type GmailConnection = ResultOf<typeof GmailConnectionsDocument>["gmailConnections"][number];
export type GmailConnectionSummary = ResultOf<
  typeof GmailConnectionSummaryDocument
>["gmailConnectionSummary"];
export type EntitySummary = ResultOf<typeof EntitiesDocument>["entities"][number];
export type EntityDetail = ResultOf<typeof EntityDocument>["entity"];
export type KnowledgeGraphSchema = ResultOf<
  typeof KnowledgeGraphSchemaDocument
>["schemaDefinition"];
export type PlexConnection = ResultOf<typeof PlexConnectionsDocument>["plexConnections"][number];
export type PlexDetection = ResultOf<
  typeof DetectLocalPlexConnectionDocument
>["detectLocalPlexConnection"];
export type ConnectorSyncResult = ResultOf<typeof SyncConnectorDocument>["syncConnector"];
export type FilesystemConnection = ResultOf<
  typeof FilesystemConnectionsDocument
>["filesystemConnections"][number];

export function isConnectorName(value: string): value is ConnectorName {
  return CONNECTOR_NAMES.includes(value as ConnectorName);
}

export async function getConnectorStatuses() {
  const data = await graphqlRequest(ConnectorStatusesDocument);
  return data.connectorStatuses;
}

export async function getGoogleCalendars() {
  const data = await graphqlRequest(GoogleCalendarsDocument);
  return data.googleCalendars;
}

export async function getGoogleCalendarConnections() {
  const data = await graphqlRequest(GoogleCalendarConnectionsDocument);
  return data.googleCalendarConnections;
}

export async function getGmailConnections() {
  const data = await graphqlRequest(GmailConnectionsDocument);
  return data.gmailConnections;
}

export async function getGmailConnectionSummary(connectionId: number) {
  const data = await graphqlRequest(GmailConnectionSummaryDocument, { connectionId });
  return data.gmailConnectionSummary;
}

export async function getPlexConnections() {
  const data = await graphqlRequest(PlexConnectionsDocument);
  return data.plexConnections;
}

export async function getFilesystemConnections() {
  const data = await graphqlRequest(FilesystemConnectionsDocument);
  return data.filesystemConnections;
}

export async function getEntities(limit = 250, offset = 0) {
  const data = await graphqlRequest(EntitiesDocument, { limit, offset });
  return data.entities;
}

export async function getEntity(uri: string) {
  const data = await graphqlRequest(EntityDocument, { uri });
  return data.entity;
}

export async function getKnowledgeGraphSchema() {
  const data = await graphqlRequest(KnowledgeGraphSchemaDocument);
  return data.schemaDefinition;
}

export async function detectLocalPlexConnection() {
  const data = await graphqlRequest(DetectLocalPlexConnectionDocument);
  return data.detectLocalPlexConnection;
}

export async function discoverGoogleCalendars() {
  const data = await graphqlRequest(DiscoverGoogleCalendarsDocument);
  return data.discoverGoogleCalendars;
}

export async function discoverGoogleCalendarsForConnection(connectionId: number) {
  const data = await graphqlRequest(DiscoverGoogleCalendarsForConnectionDocument, {
    connectionId,
  });

  return data.discoverGoogleCalendarsForConnection;
}

export async function selectGoogleCalendars(calendarIds: string[]) {
  const data = await graphqlRequest(SelectGoogleCalendarsDocument, {
    input: { calendarIds },
  });

  return data.selectGoogleCalendars;
}

export async function selectGoogleCalendarsForConnection(
  connectionId: number,
  calendarIds: string[],
) {
  const data = await graphqlRequest(SelectGoogleCalendarsForConnectionDocument, {
    connectionId,
    input: { calendarIds },
  });

  return data.selectGoogleCalendarsForConnection;
}

export async function syncConnector(name: ConnectorName) {
  const data = await graphqlRequest(SyncConnectorDocument, { name });
  return data.syncConnector;
}

export async function deleteGoogleConnection(connectionId: number) {
  const data = await graphqlRequest(DeleteGoogleConnectionDocument, { connectionId });
  return data.deleteGoogleConnection;
}

export async function savePlexConnection(
  name: string,
  baseUrl: string,
  token: string,
  libraries: string[],
) {
  const data = await graphqlRequest(SavePlexConnectionDocument, {
    input: { name, baseUrl, token, libraries },
  });
  return data.savePlexConnection;
}

export async function deletePlexConnection(connectionId: number) {
  const data = await graphqlRequest(DeletePlexConnectionDocument, { connectionId });
  return data.deletePlexConnection;
}

export async function saveFilesystemConnection(name: string, rootPath: string) {
  const data = await graphqlRequest(SaveFilesystemConnectionDocument, {
    input: { name, rootPath },
  });
  return data.saveFilesystemConnection;
}

export async function deleteFilesystemConnection(connectionId: number) {
  const data = await graphqlRequest(DeleteFilesystemConnectionDocument, { connectionId });
  return data.deleteFilesystemConnection;
}

export async function discoverPlexLibraries(baseUrl: string, token: string) {
  const data = await graphqlRequest(DiscoverPlexLibrariesDocument, { baseUrl, token });
  return data.discoverPlexLibraries;
}

async function graphqlRequest<TData, TVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables?: VariablesOf<TypedDocumentNode<TData, TVariables>>,
): Promise<TData> {
  const response = await fetch(`${resolveApiBaseUrl()}/gql`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: print(document),
      variables,
    }),
  });

  const payload = (await response.json()) as GraphqlEnvelope<TData>;
  if (!response.ok) {
    throw new Error(`Local API request failed with status ${response.status}`);
  }

  if (payload.errors?.length) {
    throw new Error(
      payload.errors
        .map((error) => error.message)
        .filter((message): message is string => Boolean(message))
        .join("; "),
    );
  }

  if (!payload.data) {
    throw new Error("Local API returned no data");
  }

  return payload.data;
}

function resolveApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return DEFAULT_LOCAL_API_BASE_URL;
  }

  return window.poneglyph?.apiBaseUrl ?? DEFAULT_LOCAL_API_BASE_URL;
}
