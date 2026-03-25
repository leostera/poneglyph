/* eslint-disable */
import type { TypedDocumentNode as DocumentNode } from "@graphql-typed-document-node/core";
export type Maybe<T> = T | null;
export type InputMaybe<T> = T | null | undefined;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = {
  [_ in K]?: never;
};
export type Incremental<T> =
  | T
  | { [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
};

export type ConnectorStatus = {
  __typename?: "ConnectorStatus";
  connected: Scalars["Boolean"]["output"];
  enabled: Scalars["Boolean"]["output"];
  lastError?: Maybe<Scalars["String"]["output"]>;
  lastSyncedAt?: Maybe<Scalars["String"]["output"]>;
  name: Scalars["String"]["output"];
  selectedResourceCount: Scalars["Int"]["output"];
};

export type ConnectorSyncResult = {
  __typename?: "ConnectorSyncResult";
  message: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  synced: Scalars["Boolean"]["output"];
};

export type GoogleCalendarResource = {
  __typename?: "GoogleCalendarResource";
  calendarId: Scalars["String"]["output"];
  description?: Maybe<Scalars["String"]["output"]>;
  primary: Scalars["Boolean"]["output"];
  selected: Scalars["Boolean"]["output"];
  summary: Scalars["String"]["output"];
  timeZone?: Maybe<Scalars["String"]["output"]>;
};

export type Mutation = {
  __typename?: "Mutation";
  discoverGoogleCalendars: Array<GoogleCalendarResource>;
  selectGoogleCalendars: Array<GoogleCalendarResource>;
  syncConnector: ConnectorSyncResult;
};

export type MutationSelectGoogleCalendarsArgs = {
  input: SelectGoogleCalendarsInput;
};

export type MutationSyncConnectorArgs = {
  name: Scalars["String"]["input"];
};

export type Query = {
  __typename?: "Query";
  connectorStatuses: Array<ConnectorStatus>;
  googleCalendars: Array<GoogleCalendarResource>;
};

export type SelectGoogleCalendarsInput = {
  calendarIds: Array<Scalars["String"]["input"]>;
};

export type ConnectorStatusesQueryVariables = Exact<{ [key: string]: never }>;

export type ConnectorStatusesQuery = {
  __typename?: "Query";
  connectorStatuses: Array<{
    __typename?: "ConnectorStatus";
    name: string;
    enabled: boolean;
    connected: boolean;
    selectedResourceCount: number;
    lastSyncedAt?: string | null;
    lastError?: string | null;
  }>;
};

export type GoogleCalendarsQueryVariables = Exact<{ [key: string]: never }>;

export type GoogleCalendarsQuery = {
  __typename?: "Query";
  googleCalendars: Array<{
    __typename?: "GoogleCalendarResource";
    calendarId: string;
    summary: string;
    description?: string | null;
    timeZone?: string | null;
    primary: boolean;
    selected: boolean;
  }>;
};

export type DiscoverGoogleCalendarsMutationVariables = Exact<{ [key: string]: never }>;

export type DiscoverGoogleCalendarsMutation = {
  __typename?: "Mutation";
  discoverGoogleCalendars: Array<{
    __typename?: "GoogleCalendarResource";
    calendarId: string;
    summary: string;
    description?: string | null;
    timeZone?: string | null;
    primary: boolean;
    selected: boolean;
  }>;
};

export type SelectGoogleCalendarsMutationVariables = Exact<{
  input: SelectGoogleCalendarsInput;
}>;

export type SelectGoogleCalendarsMutation = {
  __typename?: "Mutation";
  selectGoogleCalendars: Array<{
    __typename?: "GoogleCalendarResource";
    calendarId: string;
    summary: string;
    description?: string | null;
    timeZone?: string | null;
    primary: boolean;
    selected: boolean;
  }>;
};

export type SyncConnectorMutationVariables = Exact<{
  name: Scalars["String"]["input"];
}>;

export type SyncConnectorMutation = {
  __typename?: "Mutation";
  syncConnector: {
    __typename?: "ConnectorSyncResult";
    name: string;
    synced: boolean;
    message: string;
  };
};

export const ConnectorStatusesDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "ConnectorStatuses" },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "connectorStatuses" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "name" } },
                { kind: "Field", name: { kind: "Name", value: "enabled" } },
                { kind: "Field", name: { kind: "Name", value: "connected" } },
                { kind: "Field", name: { kind: "Name", value: "selectedResourceCount" } },
                { kind: "Field", name: { kind: "Name", value: "lastSyncedAt" } },
                { kind: "Field", name: { kind: "Name", value: "lastError" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ConnectorStatusesQuery, ConnectorStatusesQueryVariables>;
export const GoogleCalendarsDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "GoogleCalendars" },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "googleCalendars" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "calendarId" } },
                { kind: "Field", name: { kind: "Name", value: "summary" } },
                { kind: "Field", name: { kind: "Name", value: "description" } },
                { kind: "Field", name: { kind: "Name", value: "timeZone" } },
                { kind: "Field", name: { kind: "Name", value: "primary" } },
                { kind: "Field", name: { kind: "Name", value: "selected" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<GoogleCalendarsQuery, GoogleCalendarsQueryVariables>;
export const DiscoverGoogleCalendarsDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "mutation",
      name: { kind: "Name", value: "DiscoverGoogleCalendars" },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "discoverGoogleCalendars" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "calendarId" } },
                { kind: "Field", name: { kind: "Name", value: "summary" } },
                { kind: "Field", name: { kind: "Name", value: "description" } },
                { kind: "Field", name: { kind: "Name", value: "timeZone" } },
                { kind: "Field", name: { kind: "Name", value: "primary" } },
                { kind: "Field", name: { kind: "Name", value: "selected" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<
  DiscoverGoogleCalendarsMutation,
  DiscoverGoogleCalendarsMutationVariables
>;
export const SelectGoogleCalendarsDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "mutation",
      name: { kind: "Name", value: "SelectGoogleCalendars" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "input" } },
          type: {
            kind: "NonNullType",
            type: {
              kind: "NamedType",
              name: { kind: "Name", value: "SelectGoogleCalendarsInput" },
            },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "selectGoogleCalendars" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "input" },
                value: { kind: "Variable", name: { kind: "Name", value: "input" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "calendarId" } },
                { kind: "Field", name: { kind: "Name", value: "summary" } },
                { kind: "Field", name: { kind: "Name", value: "description" } },
                { kind: "Field", name: { kind: "Name", value: "timeZone" } },
                { kind: "Field", name: { kind: "Name", value: "primary" } },
                { kind: "Field", name: { kind: "Name", value: "selected" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SelectGoogleCalendarsMutation, SelectGoogleCalendarsMutationVariables>;
export const SyncConnectorDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "mutation",
      name: { kind: "Name", value: "SyncConnector" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: { kind: "Variable", name: { kind: "Name", value: "name" } },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
          },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "syncConnector" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "name" },
                value: { kind: "Variable", name: { kind: "Name", value: "name" } },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "name" } },
                { kind: "Field", name: { kind: "Name", value: "synced" } },
                { kind: "Field", name: { kind: "Name", value: "message" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<SyncConnectorMutation, SyncConnectorMutationVariables>;
