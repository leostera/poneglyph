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
  googleCalendarsQueryKey,
  invalidateConnectorQueries,
  useConnectorStatusesQuery,
  useGoogleCalendarsQuery,
} from "@/features/connectors/queries";
import { discoverGoogleCalendars, selectGoogleCalendars } from "@/lib/poneglyph-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function GoogleConnectorOnboardingSelectPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statusesQuery = useConnectorStatusesQuery();
  const googleStatus = findConnectorStatus(statusesQuery.data, "gcal");
  const googleCalendarsQuery = useGoogleCalendarsQuery(Boolean(googleStatus?.enabled));
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);
  const didAutoDiscover = useRef(false);

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
    if (!googleCalendarsQuery.data) {
      return;
    }

    setSelectedCalendarIds(
      googleCalendarsQuery.data
        .filter((calendar) => calendar.selected)
        .map((calendar) => calendar.calendarId),
    );
  }, [googleCalendarsQuery.data]);

  const discoverMutation = useMutation({
    mutationFn: discoverGoogleCalendars,
    onSuccess: async (calendars) => {
      queryClient.setQueryData(googleCalendarsQueryKey, calendars);
      await invalidateConnectorQueries(queryClient);
    },
  });

  const selectMutation = useMutation({
    mutationFn: selectGoogleCalendars,
    onSuccess: async (calendars) => {
      queryClient.setQueryData(googleCalendarsQueryKey, calendars);
      await invalidateConnectorQueries(queryClient);
      navigate({
        params: { connectorId: "gcal" },
        to: "/connectors/$connectorId",
      });
    },
  });

  useEffect(() => {
    if (!googleStatus?.connected || didAutoDiscover.current) {
      return;
    }

    if (googleCalendarsQuery.isLoading || googleCalendarsQuery.data?.length) {
      return;
    }

    didAutoDiscover.current = true;
    discoverMutation.mutate();
  }, [
    discoverMutation,
    googleCalendarsQuery.data,
    googleCalendarsQuery.isLoading,
    googleStatus?.connected,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 rounded-xl border bg-background px-5 py-5">
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
            onClick={() => navigate({ to: "/connectors/google/onboard/connect" })}
            size="sm"
            variant="ghost"
          >
            Back
          </Button>
          <Button
            disabled={!googleStatus?.connected || discoverMutation.isPending}
            onClick={() => discoverMutation.mutate()}
            size="sm"
            variant="outline"
          >
            {discoverMutation.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
          <Button
            disabled={!googleCalendarsQuery.data?.length || selectMutation.isPending}
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
      ) : googleCalendarsQuery.isLoading || discoverMutation.isPending ? (
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
      ) : !googleCalendarsQuery.data?.length ? (
        <Alert>
          <AlertTitle>No calendars found yet</AlertTitle>
          <AlertDescription>
            Try refreshing the calendar list. Once calendars show up here, pick the ones you want
            and press Done.
          </AlertDescription>
        </Alert>
      ) : (
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
  component: GoogleConnectorOnboardingSelectPage,
});
