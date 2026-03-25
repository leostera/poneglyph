import { openExternalLink } from "@/actions/shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { connectorCatalog, formatSyncTimestamp } from "@/features/connectors/catalog";
import {
  findConnectorStatus,
  invalidateConnectorQueries,
  useConnectorStatusesQuery,
  useGoogleCalendarsQuery,
} from "@/features/connectors/queries";
import {
  discoverGoogleCalendars,
  isConnectorName,
  selectGoogleCalendars,
  syncConnector,
} from "@/lib/poneglyph-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Server,
} from "lucide-react";
import { useEffect, useState } from "react";

function ConnectorDetailPage() {
  const { connectorId } = Route.useParams();
  if (!isConnectorName(connectorId)) {
    throw notFound();
  }

  const connectorName = connectorId;
  const meta = connectorCatalog[connectorName];
  const Icon = meta.icon;
  const queryClient = useQueryClient();
  const statusesQuery = useConnectorStatusesQuery();
  const status = findConnectorStatus(statusesQuery.data, connectorName);
  const googleCalendarsQuery = useGoogleCalendarsQuery(
    connectorName === "gcal" && Boolean(status?.enabled),
  );
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);

  const setCalendarSelected = (calendarId: string, nextChecked: boolean) => {
    setSelectedCalendarIds((current) => {
      if (nextChecked) {
        return current.includes(calendarId) ? current : [...current, calendarId];
      }

      return current.filter((currentId) => currentId !== calendarId);
    });
  };

  const toggleCalendarSelection = (calendarId: string) => {
    setCalendarSelected(calendarId, !selectedCalendarIds.includes(calendarId));
  };

  useEffect(() => {
    if (connectorName !== "gcal" || !googleCalendarsQuery.data) {
      return;
    }

    setSelectedCalendarIds(
      googleCalendarsQuery.data
        .filter((calendar) => calendar.selected)
        .map((calendar) => calendar.calendarId),
    );
  }, [connectorName, googleCalendarsQuery.data]);

  const discoverMutation = useMutation({
    mutationFn: discoverGoogleCalendars,
    onSuccess: async (calendars) => {
      queryClient.setQueryData(["google-calendars"], calendars);
      await invalidateConnectorQueries(queryClient);
    },
  });

  const selectMutation = useMutation({
    mutationFn: selectGoogleCalendars,
    onSuccess: async (calendars) => {
      queryClient.setQueryData(["google-calendars"], calendars);
      await invalidateConnectorQueries(queryClient);
    },
  });

  const syncMutation = useMutation({
    mutationFn: syncConnector,
    onSuccess: async () => {
      await invalidateConnectorQueries(queryClient);
    },
  });

  const syncPending = syncMutation.isPending && syncMutation.variables === connectorName;

  return (
    <div className="min-h-full px-8 py-7">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-start justify-between gap-6 pb-6">
          <div className="space-y-1.5">
            <Button asChild className="-ml-2" size="sm" variant="ghost">
              <Link to="/connectors">
                <ArrowLeft />
                Back to connectors
              </Link>
            </Button>
            <div className="flex items-center gap-3">
              <div className="rounded-lg border p-2 text-muted-foreground">
                <Icon className="size-4" />
              </div>
              <div>
                <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                  Connector
                </div>
                <h1 className="text-[28px] font-semibold tracking-tight">{meta.title}</h1>
              </div>
            </div>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{meta.summary}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {connectorName === "gcal" ? (
              <Button
                onClick={() => openExternalLink(`${window.poneglyph.apiBaseUrl}/auth/google/login`)}
                size="sm"
                variant="ghost"
              >
                <ExternalLink />
                Connect
              </Button>
            ) : null}
            {connectorName === "gcal" ? (
              <Button
                disabled={!status?.connected || discoverMutation.isPending}
                onClick={() => discoverMutation.mutate()}
                size="sm"
                variant="ghost"
              >
                {discoverMutation.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Discover
              </Button>
            ) : null}
            <Button
              disabled={!status?.enabled || syncPending}
              onClick={() => syncMutation.mutate(connectorName)}
              size="sm"
              variant="outline"
            >
              {syncPending ? <LoaderCircle className="animate-spin" /> : <Server />}
              Sync now
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link params={{ connectorId: connectorName }} to="/connectors/$connectorId/logs">
                Logs
              </Link>
            </Button>
          </div>
        </header>

        {statusesQuery.error ? (
          <Alert className="mb-6" variant="destructive">
            <AlertTitle>Local daemon unavailable</AlertTitle>
            <AlertDescription>{statusesQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-6">
          <div className="overflow-hidden rounded-xl border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[220px]">Field</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="text-muted-foreground">Runtime state</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={status?.enabled ? "secondary" : "outline"}>
                        {status?.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <Badge variant={status?.connected ? "secondary" : "outline"}>
                        {status?.connected ? "Connected" : "Waiting"}
                      </Badge>
                      {status?.lastError ? <Badge variant="destructive">Error</Badge> : null}
                    </div>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Selected resources</TableCell>
                  <TableCell>{status?.selectedResourceCount ?? 0}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Last sync</TableCell>
                  <TableCell>{formatSyncTimestamp(status?.lastSyncedAt)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Last error</TableCell>
                  <TableCell>{status?.lastError ?? "No connector errors recorded"}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {connectorName === "gcal" ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-medium">Calendar selection</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Discover calendars first, then choose which resources should remain in sync.
                </p>
              </div>

              {!status?.connected ? (
                <Alert>
                  <AlertTitle>Google Calendar is not connected</AlertTitle>
                  <AlertDescription>
                    Start the browser auth flow, then return here to discover calendars and save the
                    calendars that should stay in sync.
                  </AlertDescription>
                </Alert>
              ) : googleCalendarsQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-4/5" />
                </div>
              ) : !googleCalendarsQuery.data?.length ? (
                <Alert>
                  <AlertTitle>No calendars discovered yet</AlertTitle>
                  <AlertDescription>
                    Use Discover to fetch the available calendars for the saved Google connection.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <Button
                      disabled={selectMutation.isPending}
                      onClick={() => selectMutation.mutate(selectedCalendarIds)}
                      size="sm"
                    >
                      {selectMutation.isPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <CheckCircle2 />
                      )}
                      Save selection
                    </Button>
                  </div>

                  <div className="overflow-hidden rounded-xl border bg-background">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">Sync</TableHead>
                          <TableHead>Calendar</TableHead>
                          <TableHead>Timezone</TableHead>
                          <TableHead>State</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {googleCalendarsQuery.data.map((calendar) => {
                          const checked = selectedCalendarIds.includes(calendar.calendarId);

                          return (
                            <TableRow
                              className="cursor-pointer"
                              data-state={checked ? "selected" : undefined}
                              key={calendar.calendarId}
                              onClick={() => toggleCalendarSelection(calendar.calendarId)}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") {
                                  return;
                                }

                                event.preventDefault();
                                toggleCalendarSelection(calendar.calendarId);
                              }}
                              tabIndex={0}
                            >
                              <TableCell>
                                <Checkbox
                                  aria-label={`Toggle ${calendar.summary}`}
                                  checked={checked}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                  }}
                                  onCheckedChange={(value) => {
                                    setCalendarSelected(calendar.calendarId, Boolean(value));
                                  }}
                                />
                              </TableCell>
                              <TableCell>
                                <div className="space-y-1">
                                  <div className="text-sm font-medium">{calendar.summary}</div>
                                  <div className="font-mono text-[11px] text-muted-foreground">
                                    {calendar.calendarId}
                                  </div>
                                  {calendar.description ? (
                                    <div className="text-xs text-muted-foreground">
                                      {calendar.description}
                                    </div>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell>{calendar.timeZone ?? "No timezone"}</TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1.5">
                                  {calendar.primary ? (
                                    <Badge variant="outline">Primary</Badge>
                                  ) : null}
                                  {calendar.selected ? (
                                    <Badge variant="secondary">Selected</Badge>
                                  ) : null}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Alert>
              <AlertTitle>Plex is configuration-driven today</AlertTitle>
              <AlertDescription>
                Plex setup is currently controlled by the daemon config and the reachable local Plex
                Media Server. This screen lets you inspect runtime state and trigger syncs while the
                more detailed config flow catches up.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/connectors/$connectorId/")({
  component: ConnectorDetailPage,
});
