import {
  type ConnectorName,
  type ConnectorStatus,
  getConnectorStatuses,
  getFilesystemConnections,
  getGmailConnectionSummary,
  getGmailConnections,
  getGoogleCalendarConnections,
  getGoogleCalendars,
  getPlexConnections,
} from "@/lib/poneglyph-api";
import { type QueryClient, type UseQueryOptions, useQuery } from "@tanstack/react-query";

export const connectorStatusesQueryKey = ["connector-statuses"] as const;
export const googleCalendarsQueryKey = ["google-calendars"] as const;
export const googleCalendarConnectionsQueryKey = ["google-calendar-connections"] as const;
export const gmailConnectionsQueryKey = ["gmail-connections"] as const;
export const plexConnectionsQueryKey = ["plex-connections"] as const;
export const filesystemConnectionsQueryKey = ["filesystem-connections"] as const;
export const gmailConnectionSummaryQueryKey = (connectionId: number | null) =>
  ["gmail-connection-summary", connectionId] as const;

type ConnectorStatusesQueryOptions = Pick<
  UseQueryOptions<ConnectorStatus[], Error>,
  "refetchInterval"
>;

export function useConnectorStatusesQuery(options?: ConnectorStatusesQueryOptions) {
  return useQuery({
    queryKey: connectorStatusesQueryKey,
    queryFn: getConnectorStatuses,
    refetchInterval: options?.refetchInterval ?? 7_500,
  });
}

export function useGoogleCalendarsQuery(enabled: boolean) {
  return useQuery({
    queryKey: googleCalendarsQueryKey,
    queryFn: getGoogleCalendars,
    enabled,
  });
}

export function useGoogleCalendarConnectionsQuery(enabled: boolean) {
  return useQuery({
    queryKey: googleCalendarConnectionsQueryKey,
    queryFn: getGoogleCalendarConnections,
    enabled,
  });
}

export function useGmailConnectionsQuery(enabled: boolean) {
  return useQuery({
    queryKey: gmailConnectionsQueryKey,
    queryFn: getGmailConnections,
    enabled,
  });
}

export function usePlexConnectionsQuery(enabled: boolean) {
  return useQuery({
    queryKey: plexConnectionsQueryKey,
    queryFn: getPlexConnections,
    enabled,
  });
}

export function useFilesystemConnectionsQuery(enabled: boolean) {
  return useQuery({
    queryKey: filesystemConnectionsQueryKey,
    queryFn: getFilesystemConnections,
    enabled,
  });
}

export function useGmailConnectionSummaryQuery(connectionId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: gmailConnectionSummaryQueryKey(connectionId),
    queryFn: () => getGmailConnectionSummary(connectionId as number),
    enabled: enabled && connectionId != null,
  });
}

export function findConnectorStatus(
  statuses: ConnectorStatus[] | undefined,
  connectorName: ConnectorName,
) {
  return statuses?.find((status) => status.name === connectorName) ?? null;
}

export async function invalidateConnectorQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: connectorStatusesQueryKey }),
    queryClient.invalidateQueries({ queryKey: googleCalendarsQueryKey }),
    queryClient.invalidateQueries({ queryKey: googleCalendarConnectionsQueryKey }),
    queryClient.invalidateQueries({ queryKey: gmailConnectionsQueryKey }),
    queryClient.invalidateQueries({ queryKey: plexConnectionsQueryKey }),
    queryClient.invalidateQueries({ queryKey: filesystemConnectionsQueryKey }),
    queryClient.invalidateQueries({ queryKey: ["gmail-connection-summary"] }),
  ]);
}
