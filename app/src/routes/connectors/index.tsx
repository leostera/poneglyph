import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
  connectorCatalog,
  connectorOrder,
  formatSyncTimestamp,
} from "@/features/connectors/catalog";
import {
  findConnectorStatus,
  invalidateConnectorQueries,
  useConnectorStatusesQuery,
} from "@/features/connectors/queries";
import { type ConnectorName, syncConnector } from "@/lib/poneglyph-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Pause, Plus, RefreshCw, Server } from "lucide-react";
import { useMemo, useState } from "react";

function ConnectorsOverviewPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const statusesQuery = useConnectorStatusesQuery();
  const [selectedConnectorNames, setSelectedConnectorNames] = useState<ConnectorName[]>([]);

  const availableConnectorNames = useMemo(
    () =>
      connectorOrder.filter((connectorName) =>
        Boolean(findConnectorStatus(statusesQuery.data, connectorName)?.enabled),
      ),
    [statusesQuery.data],
  );
  const configuredConnectorNames = useMemo(
    () =>
      connectorOrder.filter((connectorName) =>
        Boolean(findConnectorStatus(statusesQuery.data, connectorName)?.connected),
      ),
    [statusesQuery.data],
  );

  const allSelectableChecked =
    availableConnectorNames.length > 0 &&
    availableConnectorNames.every((connectorName) =>
      selectedConnectorNames.includes(connectorName),
    );
  const selectedCount = selectedConnectorNames.length;

  const openConnector = (connectorId: ConnectorName) => {
    navigate({
      to: "/connectors/$connectorId",
      params: { connectorId },
    });
  };

  const bulkSyncMutation = useMutation({
    mutationFn: async (connectorNames: ConnectorName[]) => {
      return Promise.all(connectorNames.map((connectorName) => syncConnector(connectorName)));
    },
    onSuccess: async () => {
      await invalidateConnectorQueries(queryClient);
    },
  });

  const isRefreshing = statusesQuery.isFetching || bulkSyncMutation.isPending;

  const setConnectorSelected = (connectorName: ConnectorName, nextChecked: boolean) => {
    setSelectedConnectorNames((current) => {
      if (nextChecked) {
        return current.includes(connectorName) ? current : [...current, connectorName];
      }

      return current.filter((currentName) => currentName !== connectorName);
    });
  };

  return (
    <div className="min-h-full px-8 py-7">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex items-start justify-between gap-6">
          <div className="space-y-1.5">
            <h1 className="text-[28px] font-semibold tracking-tight">Connectors</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Review connector health, jump into provider-specific setup, and run bulk connector
              actions without leaving the overview.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                void invalidateConnectorQueries(queryClient);
              }}
              size="sm"
              variant="ghost"
            >
              <RefreshCw className={isRefreshing ? "animate-spin" : undefined} />
              Refresh
            </Button>
            <Button asChild size="sm">
              <Link to="/connectors/add">
                <Plus />
                Add connector
              </Link>
            </Button>
          </div>
        </header>

        {statusesQuery.error ? (
          <Alert variant="destructive">
            <AlertTitle>Local daemon unavailable</AlertTitle>
            <AlertDescription>{statusesQuery.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[3px] border bg-background px-4 py-3">
          <div className="text-sm text-muted-foreground">
            {selectedCount === 0
              ? `${configuredConnectorNames.length} configured connectors`
              : `${selectedCount} selected`}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={selectedCount === 0 || bulkSyncMutation.isPending}
              onClick={() => bulkSyncMutation.mutate(selectedConnectorNames)}
              size="sm"
              variant="outline"
            >
              {bulkSyncMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Server />}
              Force sync
            </Button>
            <Button disabled size="sm" variant="ghost">
              <Pause />
              Pause
            </Button>
          </div>
        </div>

        {statusesQuery.isLoading ? (
          <div className="overflow-hidden rounded-[3px] border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Skeleton className="h-4 w-4 rounded-sm" />
                  </TableHead>
                  <TableHead>Connector</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24">Resources</TableHead>
                  <TableHead>Last sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectorOrder.map((connectorName) => (
                  <TableRow key={`skeleton-${connectorName}`}>
                    <TableCell>
                      <Skeleton className="h-4 w-4 rounded-sm" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-44" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-10" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-36" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : configuredConnectorNames.length === 0 ? (
          <div className="rounded-[3px] border bg-background p-4">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Plus className="size-4" />
                </EmptyMedia>
                <EmptyTitle>No connectors configured yet</EmptyTitle>
                <EmptyDescription>
                  Add your first connector to start syncing data into poneglyph.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild size="sm">
                  <Link to="/connectors/add">
                    <Plus />
                    Add connector
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[3px] border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      aria-label="Select all connectors"
                      checked={allSelectableChecked}
                      onCheckedChange={(checked) => {
                        setSelectedConnectorNames(checked ? availableConnectorNames : []);
                      }}
                    />
                  </TableHead>
                  <TableHead>Connector</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24">Resources</TableHead>
                  <TableHead>Last sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {configuredConnectorNames.map((connectorName) => {
                  const meta = connectorCatalog[connectorName];
                  const status = findConnectorStatus(statusesQuery.data, connectorName);
                  const Icon = meta.icon;
                  const selected = selectedConnectorNames.includes(connectorName);

                  return (
                    <TableRow
                      className="cursor-pointer"
                      key={connectorName}
                      onClick={() => openConnector(connectorName)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") {
                          return;
                        }

                        event.preventDefault();
                        openConnector(connectorName);
                      }}
                      tabIndex={0}
                    >
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          aria-label={`Select ${meta.title}`}
                          checked={selected}
                          disabled={!status?.enabled}
                          onCheckedChange={(checked) => {
                            setConnectorSelected(connectorName, Boolean(checked));
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-md border p-2 text-muted-foreground">
                            <Icon className="size-4" />
                          </div>
                          <div className="space-y-1">
                            <div className="text-sm font-medium">{meta.title}</div>
                            <div className="max-w-md text-xs leading-5 text-muted-foreground">
                              {meta.summary}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs leading-5 text-muted-foreground">
                          <div>
                            {status?.enabled ? "Enabled" : "Disabled"} ·{" "}
                            {status?.connected ? "Connected" : "Waiting"}
                          </div>
                          <div>{status?.lastError ? "Error recorded" : "Healthy"}</div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {status?.selectedResourceCount ?? 0}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {status?.lastError
                          ? status.lastError
                          : formatSyncTimestamp(status?.lastSyncedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/connectors/")({
  component: ConnectorsOverviewPage,
});
