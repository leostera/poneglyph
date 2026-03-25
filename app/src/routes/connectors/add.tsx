import { TwoColumnLayout } from "@/components/layout/two-column-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  type ConnectorCatalogCategory,
  connectorCatalogCategories,
  connectorOfferings,
} from "@/features/connectors/catalog";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";

function AddConnectorPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ConnectorCatalogCategory>("all");

  const filteredConnectors = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return connectorOfferings.filter((connector) => {
      const matchesCategory = category === "all" || connector.category === category;

      const matchesSearch =
        normalizedSearch.length === 0 ||
        connector.title.toLowerCase().includes(normalizedSearch) ||
        connector.summary.toLowerCase().includes(normalizedSearch);

      return matchesCategory && matchesSearch;
    });
  }, [category, search]);

  const categoryCounts = useMemo(() => {
    return connectorCatalogCategories.reduce<Record<string, number>>((counts, item) => {
      counts[item.id] =
        item.id === "all"
          ? connectorOfferings.length
          : connectorOfferings.filter((connector) => connector.category === item.id).length;
      return counts;
    }, {});
  }, []);

  return (
    <div className="flex min-h-full flex-1 px-8 py-7">
      <div className="mx-auto flex w-full min-h-0 max-w-7xl flex-1">
        <TwoColumnLayout
          className="h-full gap-8"
          contentClassName="overflow-y-auto px-2 pb-10 pr-2"
          nav={
            <aside className="space-y-5">
              <div className="space-y-4">
                <Button asChild className="-ml-2" size="sm" variant="ghost">
                  <Link to="/connectors">
                    <ArrowLeft />
                    Back to connectors
                  </Link>
                </Button>

                <div className="space-y-1.5">
                  <h1 className="text-[28px] font-semibold tracking-tight">Add Connector</h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Add new connectors to Poneglyph to make their data available to your agents.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                  Filter
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search connectors"
                    value={search}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground uppercase">
                  Categories
                </div>
                <div className="space-y-1">
                  {connectorCatalogCategories.map((item) => (
                    <Button
                      className="w-full justify-between"
                      key={item.id}
                      onClick={() => setCategory(item.id)}
                      size="sm"
                      variant={category === item.id ? "secondary" : "ghost"}
                    >
                      <span>{item.label}</span>
                      <span className="text-muted-foreground">{categoryCounts[item.id]}</span>
                    </Button>
                  ))}
                </div>
              </div>
            </aside>
          }
          navClassName="w-[260px] shrink-0"
          content={
            <section className="space-y-3">
              <div className="flex min-h-9 items-center justify-between gap-4">
                <div className="text-sm text-muted-foreground">
                  {filteredConnectors.length} connector
                  {filteredConnectors.length === 1 ? "" : "s"}
                </div>
              </div>

              {filteredConnectors.length === 0 ? (
                <Alert>
                  <AlertTitle>No connectors match this filter</AlertTitle>
                  <AlertDescription>
                    Try a different category or clear the search to see more connector options.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="grid gap-2 xl:grid-cols-2">
                  {filteredConnectors.map((connector) => {
                    const Icon = connector.icon;
                    const isAvailable = Boolean(connector.href);

                    const card = (
                      <Card
                        className={
                          isAvailable
                            ? "gap-0 transition-colors hover:bg-muted/40"
                            : "gap-0 cursor-default border-dashed bg-muted/10 text-muted-foreground opacity-50 saturate-0"
                        }
                        key={connector.id}
                        size="sm"
                      >
                        <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                          <div className="rounded-md border p-2 text-muted-foreground">
                            <Icon className="size-4" />
                          </div>
                          <div className="min-w-0 space-y-1">
                            <CardTitle>{connector.title}</CardTitle>
                            <CardDescription>{connector.summary}</CardDescription>
                          </div>
                        </CardHeader>
                      </Card>
                    );

                    return connector.href ? (
                      <Link className="block" key={connector.id} to={connector.href}>
                        {card}
                      </Link>
                    ) : (
                      <div aria-disabled="true" className="block" key={connector.id}>
                        {card}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          }
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/connectors/add")({
  component: AddConnectorPage,
});
