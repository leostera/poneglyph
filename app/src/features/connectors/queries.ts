import {
  type ConnectorName,
  type ConnectorStatus,
  getConnectorStatuses,
  getGoogleCalendarConnections,
  getGoogleCalendars,
} from "@/lib/poneglyph-api";
import { type QueryClient, type UseQueryOptions, useQuery } from "@tanstack/react-query";

export const connectorStatusesQueryKey = ["connector-statuses"] as const;
export const googleCalendarsQueryKey = ["google-calendars"] as const;
export const googleCalendarConnectionsQueryKey = ["google-calendar-connections"] as const;

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
  ]);
}
