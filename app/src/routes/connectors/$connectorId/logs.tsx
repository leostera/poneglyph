import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  useConnectorStatusesQuery,
  useGoogleCalendarConnectionsQuery,
} from "@/features/connectors/queries";
import { isConnectorName } from "@/lib/poneglyph-api";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

function ConnectorLogsPage() {
  const { connectorId } = Route.useParams();
  if (!isConnectorName(connectorId)) {
    throw notFound();
  }

  const connectorName = connectorId;
  const meta = connectorCatalog[connectorName];
  const statusQuery = useConnectorStatusesQuery();
  const status = findConnectorStatus(statusQuery.data, connectorName);
  const googleConnectionsQuery = useGoogleCalendarConnectionsQuery(
    connectorName === "gcal" && Boolean(status?.connected),
  );
  const googleCalendars =
    googleConnectionsQuery.data?.flatMap((connection) => connection.calendars) ?? [];

  return (
    <div className="min-h-full px-8 py-7">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-start justify-between gap-6 pb-6">
          <div className="space-y-1.5">
            <Button asChild className="-ml-2" size="sm" variant="ghost">
              <Link params={{ connectorId: connectorName }} to="/connectors/$connectorId">
                <ArrowLeft />
                Back to details
              </Link>
            </Button>
            <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
              Connector logs
            </div>
            <h1 className="text-[28px] font-semibold tracking-tight">{meta.title}</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Inspect the current connector state and the latest daemon checkpoints while the full
              event stream is still being exposed.
            </p>
          </div>
        </header>

        <Alert className="mb-6">
          <AlertTitle>Runtime event stream is still minimal</AlertTitle>
          <AlertDescription>
            The daemon does not expose a full connector event log yet, so this screen shows the
            latest known checkpoints and selected resources.
          </AlertDescription>
        </Alert>

        <div className="space-y-6">
          <div className="overflow-hidden rounded-[3px] border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[220px]">Signal</TableHead>
                  <TableHead>Current value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="text-muted-foreground">Runtime state</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={status?.connected ? "secondary" : "outline"}>
                        {status?.connected ? "Connected" : "Waiting"}
                      </Badge>
                      {status?.lastError ? <Badge variant="destructive">Error</Badge> : null}
                    </div>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Last sync checkpoint</TableCell>
                  <TableCell>{formatSyncTimestamp(status?.lastSyncedAt)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Last connector error</TableCell>
                  <TableCell>{status?.lastError ?? "No connector errors recorded"}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Selected resources</TableCell>
                  <TableCell>{status?.selectedResourceCount ?? 0}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          {connectorName === "gcal" && googleCalendars.length > 0 ? (
            <div className="overflow-hidden rounded-[3px] border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Calendar</TableHead>
                    <TableHead>Timezone</TableHead>
                    <TableHead>Selection</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {googleCalendars.map((calendar) => (
                    <TableRow key={`${calendar.connectionId}:${calendar.calendarId}`}>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="text-sm font-medium">{calendar.summary}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {calendar.calendarId}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{calendar.timeZone ?? "No timezone"}</TableCell>
                      <TableCell>
                        {calendar.selected ? (
                          <Badge variant="secondary">Selected</Badge>
                        ) : (
                          <Badge variant="outline">Ignored</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/connectors/$connectorId/logs")({
  component: ConnectorLogsPage,
});
