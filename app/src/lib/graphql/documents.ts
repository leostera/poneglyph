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
      calendarId
      summary
      description
      timeZone
      primary
      selected
    }
  }
`);

export const DiscoverGoogleCalendarsDocument = graphql(`
  mutation DiscoverGoogleCalendars {
    discoverGoogleCalendars {
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
      calendarId
      summary
      description
      timeZone
      primary
      selected
    }
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
