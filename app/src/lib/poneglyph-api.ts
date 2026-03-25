import {
  ConnectorStatusesDocument,
  DiscoverGoogleCalendarsDocument,
  GoogleCalendarsDocument,
  SelectGoogleCalendarsDocument,
  SyncConnectorDocument,
} from "@/lib/graphql/documents";
import type { ResultOf, VariablesOf } from "@graphql-typed-document-node/core";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { print } from "graphql";

type GraphqlEnvelope<TData> = {
  data?: TData;
  errors?: Array<{ message?: string }>;
};

const CONNECTOR_NAMES = ["plex", "gcal"] as const;

export type ConnectorName = (typeof CONNECTOR_NAMES)[number];
export type ConnectorStatus = ResultOf<
  typeof ConnectorStatusesDocument
>["connectorStatuses"][number];
export type GoogleCalendarResource = ResultOf<
  typeof GoogleCalendarsDocument
>["googleCalendars"][number];
export type ConnectorSyncResult = ResultOf<typeof SyncConnectorDocument>["syncConnector"];

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

export async function discoverGoogleCalendars() {
  const data = await graphqlRequest(DiscoverGoogleCalendarsDocument);
  return data.discoverGoogleCalendars;
}

export async function selectGoogleCalendars(calendarIds: string[]) {
  const data = await graphqlRequest(SelectGoogleCalendarsDocument, {
    input: { calendarIds },
  });

  return data.selectGoogleCalendars;
}

export async function syncConnector(name: ConnectorName) {
  const data = await graphqlRequest(SyncConnectorDocument, { name });
  return data.syncConnector;
}

async function graphqlRequest<TData, TVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables?: VariablesOf<TypedDocumentNode<TData, TVariables>>,
): Promise<TData> {
  const response = await fetch(`${window.poneglyph.apiBaseUrl}/gql`, {
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
