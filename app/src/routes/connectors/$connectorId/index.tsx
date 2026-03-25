import { openExternalLink } from "@/actions/shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  useGoogleCalendarConnectionsQuery,
  usePlexConnectionsQuery,
} from "@/features/connectors/queries";
import {
  deleteGoogleConnection,
  deletePlexConnection,
  detectLocalPlexConnection,
  discoverGoogleCalendarsForConnection,
  discoverPlexLibraries,
  isConnectorName,
  savePlexConnection,
  selectGoogleCalendarsForConnection,
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
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  const googleConnectionsQuery = useGoogleCalendarConnectionsQuery(
    connectorName === "gcal" && Boolean(status?.enabled),
  );
  const plexConnectionsQuery = usePlexConnectionsQuery(
    connectorName === "plex" && Boolean(status?.enabled),
  );

  const [selectedConnectionId, setSelectedConnectionId] = useState<number | null>(null);
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);
  const [plexBaseUrl, setPlexBaseUrl] = useState("");
  const [plexToken, setPlexToken] = useState("");
  const [discoveredPlexLibraries, setDiscoveredPlexLibraries] = useState<string[]>([]);
  const [selectedPlexLibraries, setSelectedPlexLibraries] = useState<string[]>([]);
  const [plexLibraryCandidate, setPlexLibraryCandidate] = useState("");
  const [selectedPlexConnectionId, setSelectedPlexConnectionId] = useState<number | null>(null);

  const selectedConnection = useMemo(() => {
    if (connectorName !== "gcal") {
      return null;
    }
    const connections = googleConnectionsQuery.data ?? [];
    if (connections.length === 0) {
      return null;
    }
    if (selectedConnectionId == null) {
      return connections[0];
    }
    return (
      connections.find((connection) => connection.id === selectedConnectionId) ?? connections[0]
    );
  }, [connectorName, googleConnectionsQuery.data, selectedConnectionId]);

  const selectedCalendars = selectedConnection?.calendars ?? [];
  const selectedPlexConnection = useMemo(() => {
    if (connectorName !== "plex") {
      return null;
    }
    const connections = plexConnectionsQuery.data ?? [];
    if (connections.length === 0) {
      return null;
    }
    if (selectedPlexConnectionId == null) {
      return connections[0];
    }
    return connections.find((connection) => connection.id === selectedPlexConnectionId) ?? null;
  }, [connectorName, plexConnectionsQuery.data, selectedPlexConnectionId]);

  useEffect(() => {
    if (selectedConnectionId == null && selectedConnection != null) {
      setSelectedConnectionId(selectedConnection.id);
    }
  }, [selectedConnection, selectedConnectionId]);

  useEffect(() => {
    if (selectedConnection == null) {
      setSelectedCalendarIds([]);
      return;
    }

    setSelectedCalendarIds(
      selectedConnection.calendars
        .filter((calendar) => calendar.selected)
        .map((calendar) => calendar.calendarId),
    );
  }, [selectedConnection]);

  useEffect(() => {
    if (selectedPlexConnection == null) {
      if (plexConnectionsQuery.data?.length) {
        setSelectedPlexConnectionId(plexConnectionsQuery.data[0].id);
      }
      return;
    }
    if (selectedPlexConnectionId == null) {
      setSelectedPlexConnectionId(selectedPlexConnection.id);
    }
  }, [plexConnectionsQuery.data, selectedPlexConnection, selectedPlexConnectionId]);

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

  const discoverMutation = useMutation({
    mutationFn: (connectionId: number) => discoverGoogleCalendarsForConnection(connectionId),
    onSuccess: async () => {
      await invalidateConnectorQueries(queryClient);
    },
  });

  const selectMutation = useMutation({
    mutationFn: (input: { connectionId: number; calendarIds: string[] }) =>
      selectGoogleCalendarsForConnection(input.connectionId, input.calendarIds),
    onSuccess: async () => {
      await invalidateConnectorQueries(queryClient);
    },
  });

  const syncMutation = useMutation({
    mutationFn: syncConnector,
    onSuccess: async () => {
      await invalidateConnectorQueries(queryClient);
    },
  });

  const deleteConnectionMutation = useMutation({
    mutationFn: (connectionId: number) => deleteGoogleConnection(connectionId),
    onSuccess: async () => {
      setSelectedConnectionId(null);
      await invalidateConnectorQueries(queryClient);
    },
  });

  const savePlexConnectionMutation = useMutation({
    mutationFn: (input: { baseUrl: string; token: string; libraries: string[] }) =>
      savePlexConnection(input.baseUrl, input.token, input.libraries),
    onSuccess: async (connection) => {
      setSelectedPlexConnectionId(connection.id);
      setPlexToken("");
      await invalidateConnectorQueries(queryClient);
    },
  });

  const deletePlexConnectionMutation = useMutation({
    mutationFn: (connectionId: number) => deletePlexConnection(connectionId),
    onSuccess: async () => {
      setSelectedPlexConnectionId(null);
      await invalidateConnectorQueries(queryClient);
    },
  });

  const detectPlexConnectionMutation = useMutation({
    mutationFn: detectLocalPlexConnection,
    onSuccess: (detected) => {
      setPlexBaseUrl(detected.baseUrl);
      if (detected.token) {
        setPlexToken(detected.token);
      }
    },
  });

  const discoverPlexLibrariesMutation = useMutation({
    mutationFn: (input: { baseUrl: string; token: string }) =>
      discoverPlexLibraries(input.baseUrl, input.token),
    onSuccess: (libraries) => {
      setDiscoveredPlexLibraries(libraries);
      setSelectedPlexLibraries(libraries);
      setPlexLibraryCandidate(libraries[0] ?? "");
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
              <div className="rounded-[3px] border p-2 text-muted-foreground">
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
                Connect account
              </Button>
            ) : null}
            {connectorName === "gcal" ? (
              <Button
                disabled={
                  !status?.connected || discoverMutation.isPending || selectedConnection == null
                }
                onClick={() => {
                  if (selectedConnection == null) {
                    return;
                  }
                  discoverMutation.mutate(selectedConnection.id);
                }}
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
          {connectorName === "gcal" ? (
            <div className="flex flex-col gap-8 lg:h-[calc(100vh-260px)] lg:flex-row lg:items-start">
              <aside className="space-y-3 lg:h-fit lg:w-[320px] lg:shrink-0 lg:sticky lg:top-7">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                    Google accounts
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Select the account connection you want to manage.
                  </p>
                </div>
                <div className="w-full rounded-[3px] border bg-background">
                  {!status?.connected ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      No connected accounts yet.
                    </div>
                  ) : googleConnectionsQuery.isLoading ? (
                    <div className="space-y-2 px-4 py-3">
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  ) : !googleConnectionsQuery.data?.length ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      No accounts discovered yet.
                    </div>
                  ) : (
                    <div className="divide-y">
                      {googleConnectionsQuery.data.map((connection) => (
                        <button
                          className={`w-full px-4 py-3 text-left ${
                            selectedConnection?.id === connection.id ? "bg-muted/50" : ""
                          }`}
                          key={connection.id}
                          onClick={() => setSelectedConnectionId(connection.id)}
                          type="button"
                        >
                          <div className="text-sm font-medium">{connection.label}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {connection.calendars.length} calendars ·{" "}
                            {connection.selectedResourceCount} selected
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </aside>

              <section className="min-w-0 flex-1 space-y-3 pb-6 lg:pr-2">
                {!status?.connected ? (
                  <Alert>
                    <AlertTitle>Google Calendar is not connected</AlertTitle>
                    <AlertDescription>
                      Start the browser auth flow, then return here to discover calendars and save
                      the calendars that should stay in sync.
                    </AlertDescription>
                  </Alert>
                ) : selectedConnection == null ? (
                  <Alert>
                    <AlertTitle>Select an account</AlertTitle>
                    <AlertDescription>
                      Choose a Google account from the left column to manage its calendars.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-base font-medium">{selectedConnection.label}</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Manage which calendars from this account should stay in sync.
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge variant={status?.enabled ? "secondary" : "outline"}>
                            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-emerald-500" />
                            {status?.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                          <Badge variant={status?.connected ? "secondary" : "outline"}>
                            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-sky-500" />
                            {status?.connected ? "Connected" : "Waiting"}
                          </Badge>
                          {status?.lastError ? <Badge variant="destructive">Error</Badge> : null}
                          <span className="text-xs text-muted-foreground">
                            {status?.selectedResourceCount ?? 0} resources ·{" "}
                            {formatSyncTimestamp(status?.lastSyncedAt)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          disabled={deleteConnectionMutation.isPending}
                          onClick={() => {
                            const confirmed = window.confirm(
                              "Delete this Google account connection? This removes its calendars and sync state.",
                            );
                            if (!confirmed) {
                              return;
                            }
                            deleteConnectionMutation.mutate(selectedConnection.id);
                          }}
                          size="sm"
                          variant="destructive"
                        >
                          {deleteConnectionMutation.isPending ? (
                            <LoaderCircle className="animate-spin" />
                          ) : null}
                          Delete connection
                        </Button>
                        <Button
                          disabled={selectMutation.isPending}
                          onClick={() =>
                            selectMutation.mutate({
                              connectionId: selectedConnection.id,
                              calendarIds: selectedCalendarIds,
                            })
                          }
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
                    </div>

                    {selectedCalendars.length === 0 ? (
                      <Alert>
                        <AlertTitle>No calendars discovered yet</AlertTitle>
                        <AlertDescription>
                          Use Discover to fetch calendars for this account.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <div className="overflow-hidden rounded-[3px] border bg-background">
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
                            {selectedCalendars.map((calendar) => {
                              const checked = selectedCalendarIds.includes(calendar.calendarId);

                              return (
                                <TableRow
                                  className="cursor-pointer"
                                  data-state={checked ? "selected" : undefined}
                                  key={`${calendar.connectionId}:${calendar.calendarId}`}
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
                    )}
                  </>
                )}
              </section>
            </div>
          ) : connectorName === "plex" ? (
            <div className="flex flex-col gap-8 lg:h-[calc(100vh-260px)] lg:flex-row lg:items-start">
              <aside className="space-y-3 lg:h-fit lg:w-[320px] lg:shrink-0 lg:sticky lg:top-7">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                    Plex servers
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Add and manage multiple Plex server instances.
                  </p>
                </div>
                <div className="w-full rounded-[3px] border bg-background">
                  {plexConnectionsQuery.isLoading ? (
                    <div className="space-y-2 px-4 py-3">
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  ) : !plexConnectionsQuery.data?.length ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      No Plex servers connected yet.
                    </div>
                  ) : (
                    <div className="divide-y">
                      {plexConnectionsQuery.data.map((connection) => (
                        <button
                          className={`w-full px-4 py-3 text-left ${
                            selectedPlexConnection?.id === connection.id ? "bg-muted/50" : ""
                          }`}
                          key={connection.id}
                          onClick={() => setSelectedPlexConnectionId(connection.id)}
                          type="button"
                        >
                          <div className="text-sm font-medium">{connection.baseUrl}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {connection.libraries.length} libraries
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </aside>

              <section className="min-w-0 flex-1 space-y-3 pb-6 lg:pr-2">
                <div className="rounded-[3px] border bg-background p-4">
                  <div className="mb-3 text-sm font-medium">Add Plex server</div>
                  <div className="grid gap-2">
                    <Input
                      onChange={(event) => setPlexBaseUrl(event.target.value)}
                      placeholder="Base URL (e.g. http://127.0.0.1:32400)"
                      value={plexBaseUrl}
                    />
                    <Input
                      onChange={(event) => setPlexToken(event.target.value)}
                      placeholder="Plex token"
                      type="password"
                      value={plexToken}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      disabled={detectPlexConnectionMutation.isPending}
                      onClick={() => detectPlexConnectionMutation.mutate()}
                      size="sm"
                      variant="outline"
                    >
                      {detectPlexConnectionMutation.isPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : null}
                      Detect
                    </Button>
                    <Button
                      disabled={
                        discoverPlexLibrariesMutation.isPending ||
                        plexBaseUrl.trim() === "" ||
                        plexToken.trim() === ""
                      }
                      onClick={() =>
                        discoverPlexLibrariesMutation.mutate({
                          baseUrl: plexBaseUrl.trim(),
                          token: plexToken.trim(),
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      {discoverPlexLibrariesMutation.isPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : null}
                      Discover libraries
                    </Button>
                  </div>
                  {discoveredPlexLibraries.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      <div className="text-xs text-muted-foreground">Libraries</div>
                      <div className="flex items-center gap-2">
                        <select
                          className="h-9 min-w-[220px] rounded-[3px] border bg-background px-2 text-sm"
                          onChange={(event) => setPlexLibraryCandidate(event.target.value)}
                          value={plexLibraryCandidate}
                        >
                          {discoveredPlexLibraries.map((library) => (
                            <option key={library} value={library}>
                              {library}
                            </option>
                          ))}
                        </select>
                        <Button
                          onClick={() => {
                            if (!plexLibraryCandidate) {
                              return;
                            }
                            setSelectedPlexLibraries((current) =>
                              current.includes(plexLibraryCandidate)
                                ? current
                                : [...current, plexLibraryCandidate],
                            );
                          }}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Add
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedPlexLibraries.map((library) => (
                          <button
                            className="rounded-[3px] border bg-muted px-2 py-0.5 text-xs"
                            key={library}
                            onClick={() =>
                              setSelectedPlexLibraries((current) =>
                                current.filter((value) => value !== library),
                              )
                            }
                            type="button"
                          >
                            {library} ×
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="mt-2 text-xs text-muted-foreground">
                    Start with Detect for local Plex auto-discovery, or fill URL/token manually.
                  </div>
                  <div className="mt-3">
                    <Button
                      disabled={savePlexConnectionMutation.isPending}
                      onClick={() => {
                        savePlexConnectionMutation.mutate({
                          baseUrl: plexBaseUrl.trim(),
                          token: plexToken.trim(),
                          libraries: selectedPlexLibraries,
                        });
                      }}
                      size="sm"
                    >
                      {savePlexConnectionMutation.isPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : null}
                      Save server
                    </Button>
                  </div>
                </div>

                {selectedPlexConnection == null ? (
                  <Alert>
                    <AlertTitle>Select a Plex server</AlertTitle>
                    <AlertDescription>
                      Choose a server from the left column to view details and actions.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="rounded-[3px] border bg-background p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-2">
                        <div className="text-base font-medium">
                          {selectedPlexConnection.baseUrl}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={status?.enabled ? "secondary" : "outline"}>
                            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-emerald-500" />
                            {status?.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                          <Badge variant={status?.connected ? "secondary" : "outline"}>
                            <span className="mr-1.5 inline-block size-1.5 rounded-full bg-sky-500" />
                            {status?.connected ? "Connected" : "Waiting"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {selectedPlexConnection.libraries.length} libraries ·{" "}
                            {formatSyncTimestamp(selectedPlexConnection.lastSyncedAt)}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {selectedPlexConnection.libraries.join(", ") || "No libraries selected"}
                        </div>
                      </div>
                      <Button
                        disabled={deletePlexConnectionMutation.isPending}
                        onClick={() => {
                          const confirmed = window.confirm("Delete this Plex server connection?");
                          if (!confirmed) {
                            return;
                          }
                          deletePlexConnectionMutation.mutate(selectedPlexConnection.id);
                        }}
                        size="sm"
                        variant="destructive"
                      >
                        {deletePlexConnectionMutation.isPending ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Trash2 />
                        )}
                        Delete connection
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/connectors/$connectorId/")({
  component: ConnectorDetailPage,
});
