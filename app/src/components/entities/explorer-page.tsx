import type { EntityListRow } from "@/components/entities/list";
import { resolveEntityListView } from "@/components/entities/list-registry";
import type { EntityViewModel } from "@/components/entities/types";
import { resolveEntityView } from "@/components/entities/view-registry";
import { TwoColumnLayout } from "@/components/layout/two-column-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import {
  useEntitiesQuery,
  useEntityQuery,
  useKnowledgeGraphSchemaQuery,
} from "@/features/entities/queries";
import { formatKindScope, formatNamespaceScope, parsePoneglyphUri } from "@poneglyph/uri";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

const PAGE_SIZE = 250;
const SKELETON_ROWS = [
  "entity-skeleton-1",
  "entity-skeleton-2",
  "entity-skeleton-3",
  "entity-skeleton-4",
  "entity-skeleton-5",
  "entity-skeleton-6",
  "entity-skeleton-7",
  "entity-skeleton-8",
] as const;

type EntitiesExplorerPageProps = {
  scope?: string;
};

type ScopeSelection = {
  namespace: string | null;
  kind: string | null;
  entityUri: string | null;
  valid: boolean;
};

export function EntitiesExplorerPage({ scope }: EntitiesExplorerPageProps) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [leftFilter, setLeftFilter] = useState("");
  const selection = useMemo(() => parseScopeSelection(scope), [scope]);

  const query = useEntitiesQuery(PAGE_SIZE, offset);
  const schemaQuery = useKnowledgeGraphSchemaQuery();
  const entityQuery = useEntityQuery(selection.entityUri);
  const rows = query.data ?? [];

  const namespaceKinds = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const kind of schemaQuery.data?.kinds ?? []) {
      const [namespace, name] = kind.uri.split(":");
      if (!namespace || !name) {
        continue;
      }
      const current = result.get(namespace) ?? [];
      if (!current.includes(name)) {
        current.push(name);
      }
      result.set(namespace, current);
    }
    for (const [namespace, kinds] of result) {
      kinds.sort((left, right) => left.localeCompare(right));
      result.set(namespace, kinds);
    }
    return [...result.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [schemaQuery.data]);

  const namespaceLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const namespace of schemaQuery.data?.namespaces ?? []) {
      const [key] = namespace.uri.split(":");
      if (!key) {
        continue;
      }
      if (namespace.name) {
        labels.set(key, namespace.name);
      }
    }
    return labels;
  }, [schemaQuery.data]);

  const kindLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const kind of schemaQuery.data?.kinds ?? []) {
      if (kind.name) {
        labels.set(kind.uri, kind.name);
      }
    }
    return labels;
  }, [schemaQuery.data]);

  const filteredNamespaceKinds = useMemo(() => {
    const queryText = leftFilter.trim().toLowerCase();
    if (queryText.length === 0) {
      return namespaceKinds;
    }

    return namespaceKinds
      .map(([namespace, kinds]) => {
        const namespaceLabel = (namespaceLabels.get(namespace) ?? namespace).toLowerCase();
        const namespaceMatches =
          namespace.toLowerCase().includes(queryText) || namespaceLabel.includes(queryText);

        if (namespaceMatches) {
          return [namespace, kinds] as const;
        }

        const matchingKinds = kinds.filter((kind) => {
          const kindKey = `${namespace}:${kind}`;
          const kindLabel = (kindLabels.get(kindKey) ?? kind).toLowerCase();
          return kind.toLowerCase().includes(queryText) || kindLabel.includes(queryText);
        });

        if (matchingKinds.length === 0) {
          return null;
        }

        return [namespace, matchingKinds] as const;
      })
      .filter((entry): entry is readonly [string, string[]] => entry !== null);
  }, [kindLabels, leftFilter, namespaceKinds, namespaceLabels]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (selection.namespace && row.namespace !== selection.namespace) {
        return false;
      }
      if (selection.kind && row.kind !== selection.kind) {
        return false;
      }
      return true;
    });
  }, [rows, selection.kind, selection.namespace]);

  const hasNextPage = rows.length === PAGE_SIZE;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const ListView = resolveEntityListView(selection.namespace, selection.kind);
  const listRows: EntityListRow[] = filteredRows.map((row) => ({
    namespace: row.namespace,
    kind: row.kind,
    uri: row.uri,
    label: row.uri.split(":").pop() ?? row.uri,
    lastUpdatedAt: null,
  }));
  const namespaceTitle = selection.namespace
    ? (namespaceLabels.get(selection.namespace) ?? titleize(selection.namespace))
    : "All entities";
  const kindTitle =
    selection.namespace && selection.kind
      ? (kindLabels.get(`${selection.namespace}:${selection.kind}`) ?? titleize(selection.kind))
      : null;
  const entityDetail = entityQuery.data;
  const entityTitle = selection.entityUri?.split(":").pop() ?? selection.entityUri;
  const contentTitle = selection.entityUri
    ? `${namespaceTitle} > ${kindTitle ?? titleize(selection.kind ?? "")} > ${entityTitle}`
    : kindTitle
      ? `${namespaceTitle} > ${kindTitle}`
      : namespaceTitle;
  const View = entityDetail ? resolveEntityView(entityDetail.namespace, entityDetail.kind) : null;
  const viewEntity: EntityViewModel | null = entityDetail
    ? {
        uri: entityDetail.uri,
        namespace: entityDetail.namespace,
        kind: entityDetail.kind,
        fields: entityDetail.fields.map((field) => ({
          field: field.field,
          value: field.value,
        })),
      }
    : null;

  return (
    <div className="flex min-h-full flex-1 px-6 py-7">
      <div className="flex w-full min-h-0 flex-1">
        <TwoColumnLayout
          className="h-full"
          contentClassName="pl-5"
          nav={
            <div className="space-y-1">
              <div className="pb-2">
                <Input
                  className="h-8 text-xs"
                  onChange={(event) => setLeftFilter(event.target.value)}
                  placeholder="Filter namespaces/kinds"
                  value={leftFilter}
                />
              </div>
              <Button
                className="mb-2 h-7 w-full justify-start text-xs"
                onClick={() => {
                  void navigate({ to: "/entities" });
                }}
                size="sm"
                variant={
                  selection.namespace === null && selection.kind === null ? "secondary" : "ghost"
                }
              >
                all
              </Button>
              {filteredNamespaceKinds.map(([namespace, kinds]) => (
                <div className="space-y-1" key={namespace}>
                  <Button
                    className="h-7 w-full justify-start text-xs"
                    onClick={() => {
                      void navigate({
                        to: "/entities/$scope",
                        params: { scope: formatNamespaceScope(namespace) },
                      });
                    }}
                    size="sm"
                    variant={
                      selection.namespace === namespace && selection.kind === null
                        ? "secondary"
                        : "ghost"
                    }
                  >
                    {namespaceLabels.get(namespace) ?? titleize(namespace)}
                  </Button>
                  <div className="space-y-1 pl-3">
                    {kinds.map((kind) => (
                      <Button
                        className="h-7 w-full justify-start text-xs"
                        key={`${namespace}:${kind}`}
                        onClick={() => {
                          void navigate({
                            to: "/entities/$scope",
                            params: { scope: formatKindScope(namespace, kind) },
                          });
                        }}
                        size="sm"
                        variant={
                          selection.namespace === namespace && selection.kind === kind
                            ? "secondary"
                            : "ghost"
                        }
                      >
                        {kindLabels.get(`${namespace}:${kind}`) ?? titleize(kind)}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          }
          navClassName="w-[220px] border-r pr-4"
          content={
            <>
              <div className="mb-4 flex items-start justify-between gap-6">
                <h1 className="text-[26px] font-semibold tracking-tight">{contentTitle}</h1>
                <Button
                  onClick={() => {
                    void query.refetch();
                    void schemaQuery.refetch();
                    if (selection.entityUri) {
                      void entityQuery.refetch();
                    }
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <RefreshCw
                    className={
                      query.isFetching || schemaQuery.isFetching || entityQuery.isFetching
                        ? "animate-spin"
                        : undefined
                    }
                  />
                  Refresh
                </Button>
              </div>

              {!selection.valid ? (
                <Alert className="mb-4" variant="destructive">
                  <AlertTitle>Invalid entity scope</AlertTitle>
                  <AlertDescription>
                    The URL scope is not valid. Use `/entities`, `/entities/ns:`,
                    `/entities/ns:kind`, or `/entities/ns:kind:id`.
                  </AlertDescription>
                </Alert>
              ) : null}

              {selection.entityUri ? (
                <>
                  {entityQuery.error ? (
                    <Alert className="mb-4" variant="destructive">
                      <AlertTitle>Unable to load entity</AlertTitle>
                      <AlertDescription>{entityQuery.error.message}</AlertDescription>
                    </Alert>
                  ) : null}

                  {entityQuery.isLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-6 w-72" />
                      <Skeleton className="h-24 w-full" />
                      <Skeleton className="h-64 w-full" />
                    </div>
                  ) : viewEntity && View ? (
                    <View entity={viewEntity} />
                  ) : (
                    <Alert>
                      <AlertTitle>Entity not found</AlertTitle>
                      <AlertDescription>
                        No entity exists for URI{" "}
                        <span className="font-mono">{selection.entityUri}</span>.
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              ) : (
                <>
                  {query.error ? (
                    <Alert className="mb-4" variant="destructive">
                      <AlertTitle>Unable to load entities</AlertTitle>
                      <AlertDescription>{query.error.message}</AlertDescription>
                    </Alert>
                  ) : null}

                  <div className="overflow-hidden rounded-[3px] border bg-background">
                    {query.isLoading ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[16%]">Namespace</TableHead>
                            <TableHead className="w-[16%]">Kind</TableHead>
                            <TableHead className="w-[36%]">URI</TableHead>
                            <TableHead className="w-[20%]">Label</TableHead>
                            <TableHead>Last updated at</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {SKELETON_ROWS.map((rowId) => (
                            <TableRow key={rowId}>
                              <TableCell>
                                <Skeleton className="h-4 w-20" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-20" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-full max-w-[320px]" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-28" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-24" />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : listRows.length === 0 ? (
                      <Table>
                        <TableBody>
                          <TableRow>
                            <TableCell className="py-6 text-sm text-muted-foreground" colSpan={5}>
                              No entities in this namespace/kind scope on the current page.
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    ) : (
                      <ListView
                        onSelect={(row) => {
                          void navigate({
                            to: "/entities/$scope",
                            params: { scope: row.uri },
                          });
                        }}
                        rows={listRows}
                        selectedUri={selection.entityUri}
                      />
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between px-1 py-2">
                    <div className="text-sm text-muted-foreground">Page {page}</div>
                    <div className="flex items-center gap-2">
                      <Button
                        disabled={offset === 0 || query.isFetching}
                        onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                        size="sm"
                        variant="outline"
                      >
                        <ChevronLeft />
                        Previous
                      </Button>
                      <Button
                        disabled={!hasNextPage || query.isFetching}
                        onClick={() => setOffset((current) => current + PAGE_SIZE)}
                        size="sm"
                        variant="outline"
                      >
                        Next
                        <ChevronRight />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </>
          }
        />
      </div>
    </div>
  );
}

function parseScopeSelection(scope: string | undefined): ScopeSelection {
  if (!scope) {
    return {
      namespace: null,
      kind: null,
      entityUri: null,
      valid: true,
    };
  }

  const decoded = decodeURIComponent(scope).trim();
  if (decoded.length === 0) {
    return {
      namespace: null,
      kind: null,
      entityUri: null,
      valid: true,
    };
  }

  const parsed = parsePoneglyphUri(decoded);
  if (!parsed) {
    return {
      namespace: null,
      kind: null,
      entityUri: null,
      valid: false,
    };
  }

  if (parsed.scope === "namespace") {
    return {
      namespace: parsed.namespace,
      kind: null,
      entityUri: null,
      valid: true,
    };
  }

  if (parsed.scope === "kind") {
    return {
      namespace: parsed.namespace,
      kind: parsed.kind,
      entityUri: null,
      valid: true,
    };
  }

  return {
    namespace: parsed.namespace,
    kind: parsed.kind,
    entityUri: parsed.raw,
    valid: true,
  };
}

function titleize(value: string): string {
  if (!value) {
    return value;
  }

  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
