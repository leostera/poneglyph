import { graphql } from "./generated";

export const ConnectorStatusesDocument = graphql(`
  query ConnectorStatuses {
    connectorStatuses {
      name
      enabled
      connected
      selectedResourceCount
      lastSyncedAt
      lastError
    }
  }
`);

export const GoogleCalendarsDocument = graphql(`
  query GoogleCalendars {
    googleCalendars {
      connectionId
      calendarId
      summary
      description
      timeZone
      primary
      selected
    }
  }
`);

export const GoogleCalendarConnectionsDocument = graphql(`
  query GoogleCalendarConnections {
    googleCalendarConnections {
      id
      label
      selectedResourceCount
      lastSyncedAt
      lastError
      calendars {
        connectionId
        calendarId
        summary
        description
        timeZone
        primary
        selected
      }
    }
  }
`);

export const DiscoverGoogleCalendarsDocument = graphql(`
  mutation DiscoverGoogleCalendars {
    discoverGoogleCalendars {
      connectionId
      calendarId
      summary
      description
      timeZone
      primary
      selected
    }
  }
`);

export const DiscoverGoogleCalendarsForConnectionDocument = graphql(`
  mutation DiscoverGoogleCalendarsForConnection($connectionId: Int!) {
    discoverGoogleCalendarsForConnection(connectionId: $connectionId) {
      connectionId
      calendarId
      summary
      description
      timeZone
      primary
      selected
    }
  }
`);

export const SelectGoogleCalendarsDocument = graphql(`
  mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {
    selectGoogleCalendars(input: $input) {
      connectionId
      calendarId
      summary
      description
      timeZone
      primary
      selected
    }
  }
`);

export const SelectGoogleCalendarsForConnectionDocument = graphql(`
  mutation SelectGoogleCalendarsForConnection(
    $connectionId: Int!
    $input: SelectGoogleCalendarsInput!
  ) {
    selectGoogleCalendarsForConnection(connectionId: $connectionId, input: $input) {
      connectionId
      calendarId
      summary
      description
      timeZone
      primary
      selected
    }
  }
`);

export const DeleteGoogleConnectionDocument = graphql(`
  mutation DeleteGoogleConnection($connectionId: Int!) {
    deleteGoogleConnection(connectionId: $connectionId)
  }
`);

export const SyncConnectorDocument = graphql(`
  mutation SyncConnector($name: String!) {
    syncConnector(name: $name) {
      name
      synced
      message
    }
  }
`);
