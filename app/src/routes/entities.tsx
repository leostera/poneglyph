import type { EntityListRow } from "@/components/entities/list";
import { resolveEntityListView } from "@/components/entities/list-registry";
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
import { useEntitiesQuery, useKnowledgeGraphSchemaQuery } from "@/features/entities/queries";
import { createFileRoute } from "@tanstack/react-router";
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

function EntitiesPage() {
  const [offset, setOffset] = useState(0);
  const [leftFilter, setLeftFilter] = useState("");
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const query = useEntitiesQuery(PAGE_SIZE, offset);
  const schemaQuery = useKnowledgeGraphSchemaQuery();
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
      if (selectedNamespace && row.namespace !== selectedNamespace) {
        return false;
      }
      if (selectedKind && row.kind !== selectedKind) {
        return false;
      }
      return true;
    });
  }, [rows, selectedNamespace, selectedKind]);
  const hasNextPage = rows.length === PAGE_SIZE;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const ListView = resolveEntityListView(selectedNamespace, selectedKind);
  const listRows: EntityListRow[] = filteredRows.map((row) => ({
    namespace: row.namespace,
    kind: row.kind,
    uri: row.uri,
    label: row.uri.split(":").pop() ?? row.uri,
    lastUpdatedAt: null,
  }));
  const namespaceTitle = selectedNamespace
    ? (namespaceLabels.get(selectedNamespace) ?? titleize(selectedNamespace))
    : "All entities";
  const kindTitle =
    selectedNamespace && selectedKind
      ? (kindLabels.get(`${selectedNamespace}:${selectedKind}`) ?? titleize(selectedKind))
      : null;

  return (
    <div className="min-h-full px-6 py-7">
      <div className="w-full">
        <div className="flex h-[calc(100vh-128px)] overflow-hidden">
          <aside className="w-[220px] shrink-0 overflow-y-auto border-r pr-4">
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
                  setSelectedNamespace(null);
                  setSelectedKind(null);
                }}
                size="sm"
                variant={
                  selectedNamespace === null && selectedKind === null ? "secondary" : "ghost"
                }
              >
                all
              </Button>
              {filteredNamespaceKinds.map(([namespace, kinds]) => (
                <div className="space-y-1" key={namespace}>
                  <Button
                    className="h-7 w-full justify-start text-xs"
                    onClick={() => {
                      setSelectedNamespace(namespace);
                      setSelectedKind(null);
                    }}
                    size="sm"
                    variant={
                      selectedNamespace === namespace && selectedKind === null
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
                          setSelectedNamespace(namespace);
                          setSelectedKind(kind);
                        }}
                        size="sm"
                        variant={
                          selectedNamespace === namespace && selectedKind === kind
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
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto pl-5">
            <div className="mb-4 flex items-start justify-between gap-6">
              <div>
                <h1 className="text-[26px] font-semibold tracking-tight">
                  {kindTitle ? `${namespaceTitle} > ${kindTitle}` : namespaceTitle}
                </h1>
              </div>
              <Button
                onClick={() => {
                  void query.refetch();
                  void schemaQuery.refetch();
                }}
                size="sm"
                variant="ghost"
              >
                <RefreshCw
                  className={
                    query.isFetching || schemaQuery.isFetching ? "animate-spin" : undefined
                  }
                />
                Refresh
              </Button>
            </div>

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
                <ListView rows={listRows} />
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
          </section>
        </div>
      </div>
    </div>
  );
}

function titleize(value: string): string {
  if (!value) {
    return value;
  }

  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

export const Route = createFileRoute("/entities")({
  component: EntitiesPage,
});
