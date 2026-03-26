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

export const GmailConnectionsDocument = graphql(`
  query GmailConnections {
    gmailConnections {
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

export const GmailConnectionSummaryDocument = graphql(`
  query GmailConnectionSummary($connectionId: Int!) {
    gmailConnectionSummary(connectionId: $connectionId) {
      connectionId
      sendingAddresses
      mailboxes
      labels
      emails
      lastEmailReceivedAt
    }
  }
`);

export const AiProvidersDocument = graphql(`
  query AiProviders {
    aiProviders {
      id
      providerKey
      displayName
      baseUrl
      defaultModel
      enabled
      hasApiKey
    }
  }
`);

export const AgentAuditRunsDocument = graphql(`
  query AgentAuditRuns($limit: Int, $offset: Int) {
    agentAuditRuns(limit: $limit, offset: $offset) {
      id
      agentKey
      sessionId
      source
      status
      inputSummary
      replySummary
      errorSummary
      startedAt
      finishedAt
    }
  }
`);

export const AgentAuditEventsDocument = graphql(`
  query AgentAuditEvents($runId: String!) {
    agentAuditEvents(runId: $runId) {
      id
      runId
      seq
      eventType
      payloadJson
      occurredAt
    }
  }
`);

export const SaveAiProviderDocument = graphql(`
  mutation SaveAiProvider($input: SaveAiProviderInput!) {
    saveAiProvider(input: $input) {
      id
      providerKey
      displayName
      baseUrl
      defaultModel
      enabled
      hasApiKey
    }
  }
`);

export const DeleteAiProviderDocument = graphql(`
  mutation DeleteAiProvider($id: Int!) {
    deleteAiProvider(id: $id)
  }
`);

export const SendPoneglyphAgentMessageDocument = graphql(`
  mutation SendPoneglyphAgentMessage($input: SendPoneglyphAgentMessageInput!) {
    sendPoneglyphAgentMessage(input: $input) {
      sessionId
      runId
      reply
    }
  }
`);

export const EntitiesDocument = graphql(`
  query Entities($limit: Int, $offset: Int) {
    entities(limit: $limit, offset: $offset) {
      uri
      namespace
      kind
    }
  }
`);

export const EntityDocument = graphql(`
  query Entity($uri: String!) {
    entity(uri: $uri) {
      uri
      namespace
      kind
      fields {
        field
        value
      }
    }
  }
`);

export const KnowledgeGraphSchemaDocument = graphql(`
  query KnowledgeGraphSchema {
    schemaDefinition {
      namespaces {
        uri
        name
      }
      kinds {
        uri
        name
      }
      fields {
        uri
        name
        domain
        range
      }
    }
  }
`);

export const EntityKindsDocument = graphql(`
  query EntityKinds {
    entityKinds
  }
`);

export const PlexConnectionsDocument = graphql(`
  query PlexConnections {
    plexConnections {
      id
      name
      baseUrl
      libraries {
        id
        name
      }
      lastSyncedAt
      lastError
    }
  }
`);

export const DetectLocalPlexConnectionDocument = graphql(`
  query DetectLocalPlexConnection {
    detectLocalPlexConnection {
      baseUrl
      token
      machineIdentifier
      libraries {
        id
        name
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

export const FilesystemConnectionsDocument = graphql(`
  query FilesystemConnections {
    filesystemConnections {
      id
      name
      rootPath
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

export const SavePlexConnectionDocument = graphql(`
  mutation SavePlexConnection($input: SavePlexConnectionInput!) {
    savePlexConnection(input: $input) {
      id
      name
      baseUrl
      libraries {
        id
        name
      }
      lastSyncedAt
      lastError
    }
  }
`);

export const DeletePlexConnectionDocument = graphql(`
  mutation DeletePlexConnection($connectionId: Int!) {
    deletePlexConnection(connectionId: $connectionId)
  }
`);

export const SaveFilesystemConnectionDocument = graphql(`
  mutation SaveFilesystemConnection($input: SaveFilesystemConnectionInput!) {
    saveFilesystemConnection(input: $input) {
      id
      name
      rootPath
    }
  }
`);

export const DeleteFilesystemConnectionDocument = graphql(`
  mutation DeleteFilesystemConnection($connectionId: Int!) {
    deleteFilesystemConnection(connectionId: $connectionId)
  }
`);

export const DiscoverPlexLibrariesDocument = graphql(`
  mutation DiscoverPlexLibraries($baseUrl: String!, $token: String!) {
    discoverPlexLibraries(baseUrl: $baseUrl, token: $token) {
      id
      name
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
