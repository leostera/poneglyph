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
import {
  findConnectorStatus,
  googleCalendarConnectionsQueryKey,
  invalidateConnectorQueries,
  useConnectorStatusesQuery,
  useGoogleCalendarConnectionsQuery,
} from "@/features/connectors/queries";
import {
  discoverGoogleCalendarsForConnection,
  selectGoogleCalendarsForConnection,
} from "@/lib/poneglyph-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function GoogleConnectorOnboardingSelectPage() {
  const { connectionId } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statusesQuery = useConnectorStatusesQuery();
  const googleStatus = findConnectorStatus(statusesQuery.data, "gcal");
  const googleConnectionsQuery = useGoogleCalendarConnectionsQuery(Boolean(googleStatus?.enabled));
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);
  const didAutoDiscover = useRef(false);
  const selectedConnection =
    googleConnectionsQuery.data?.find((connection) => connection.id === connectionId) ??
    googleConnectionsQuery.data?.[0] ??
    null;
  const calendars = selectedConnection?.calendars ?? [];

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
    if (!selectedConnection) {
      return;
    }

    setSelectedCalendarIds(
      selectedConnection.calendars
        .filter((calendar) => calendar.selected)
        .map((calendar) => calendar.calendarId),
    );
  }, [selectedConnection]);

  const discoverMutation = useMutation({
    mutationFn: discoverGoogleCalendarsForConnection,
    onSuccess: async () => {
      await invalidateConnectorQueries(queryClient);
    },
  });

  const selectMutation = useMutation({
    mutationFn: (calendarIds: string[]) => {
      if (selectedConnection == null) {
        return Promise.resolve([]);
      }
      return selectGoogleCalendarsForConnection(selectedConnection.id, calendarIds);
    },
    onSuccess: async () => {
      await invalidateConnectorQueries(queryClient);
      navigate({
        params: { connectorId: "gcal" },
        to: "/connectors/$connectorId",
      });
    },
  });

  useEffect(() => {
    if (!googleStatus?.connected || didAutoDiscover.current || selectedConnection == null) {
      return;
    }

    if (googleConnectionsQuery.isLoading || calendars.length > 0) {
      return;
    }

    didAutoDiscover.current = true;
    discoverMutation.mutate(selectedConnection.id);
  }, [
    calendars.length,
    discoverMutation,
    googleConnectionsQuery.isLoading,
    googleStatus?.connected,
    selectedConnection,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 rounded-[3px] border bg-background px-5 py-5">
        <div className="space-y-2">
          <h2 className="text-base font-medium">Step 2. Choose calendars</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            We&apos;ll fetch the available calendars for this Google connection, then you can pick
            the ones that should remain in sync.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">{selectedCalendarIds.length} selected</Badge>
            <Badge variant={googleStatus?.connected ? "secondary" : "outline"}>
              {googleStatus?.connected ? "Connected" : "Waiting"}
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              navigate({
                to: "/connectors/google/onboard/connect",
                search: { destination: "gcal" },
              })
            }
            size="sm"
            variant="ghost"
          >
            Back
          </Button>
          <Button
            disabled={
              !googleStatus?.connected || discoverMutation.isPending || selectedConnection == null
            }
            onClick={() => {
              if (selectedConnection == null) {
                return;
              }
              discoverMutation.mutate(selectedConnection.id);
            }}
            size="sm"
            variant="outline"
          >
            {discoverMutation.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
          <Button
            disabled={calendars.length === 0 || selectMutation.isPending}
            onClick={() => selectMutation.mutate(selectedCalendarIds)}
            size="sm"
          >
            {selectMutation.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <CheckCircle2 />
            )}
            Done
          </Button>
        </div>
      </div>

      {!googleStatus?.connected ? (
        <Alert>
          <AlertTitle>Connect Google first</AlertTitle>
          <AlertDescription>
            The calendar picker needs a stored Google connection before the daemon can fetch
            calendars.
          </AlertDescription>
        </Alert>
      ) : googleConnectionsQuery.isLoading || discoverMutation.isPending ? (
        <div className="space-y-2">
          <Alert>
            <AlertTitle>Loading calendars</AlertTitle>
            <AlertDescription>
              Poneglyph is fetching the available Google calendars for this connection.
            </AlertDescription>
          </Alert>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-4/5" />
        </div>
      ) : calendars.length === 0 ? (
        <Alert>
          <AlertTitle>No calendars found yet</AlertTitle>
          <AlertDescription>
            Try refreshing the calendar list. Once calendars show up here, pick the ones you want
            and press Done.
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
              {calendars.map((calendar) => {
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
                        {calendar.primary ? <Badge variant="outline">Primary</Badge> : null}
                        {calendar.selected ? (
                          <Badge variant="secondary">Saved</Badge>
                        ) : (
                          <Badge variant="outline">Unsaved</Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/connectors/google/onboard/select")({
  validateSearch: (search: Record<string, unknown>) => ({
    connectionId: typeof search.connectionId === "number" ? search.connectionId : undefined,
  }),
  component: GoogleConnectorOnboardingSelectPage,
});
