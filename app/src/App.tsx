import {
  Badge,
  Button,
  Card,
  CommandDialog,
  CommandItem,
  Kbd,
  NavItem,
  StatusDot,
  ThemeRoot,
} from "@poneglyph/ui";
import { useEffect, useMemo, useRef, useState } from "react";

const searchEntries = [
  {
    title: "rush / 2112",
    meta: "spotify:album:1xndb8d9an",
    kind: "album",
  },
  {
    title: "rush",
    meta: "spotify:artist:2910301nxo",
    kind: "artist",
  },
  {
    title: "mcp service",
    meta: "local runtime",
    kind: "service",
  },
  {
    title: "search projection",
    meta: "tantivy projection",
    kind: "projection",
  },
];

const graphNodes = [
  { id: "album", label: "2112", x: 168, y: 96, active: true },
  { id: "artist", label: "Rush", x: 80, y: 186, active: false },
  { id: "projection", label: "Search", x: 256, y: 186, active: false },
  { id: "mcp", label: "MCP", x: 168, y: 272, active: false },
];

const graphEdges = [
  ["album", "artist"],
  ["album", "projection"],
  ["projection", "mcp"],
];

const facts = [
  {
    field: "spotify:displayName",
    value: "2112",
    tx: "0195f7ee-2be0-7e3c-b0ef-6cc3459b1d44",
  },
  {
    field: "spotify:byArtist",
    value: "spotify:artist:2910301nxo",
    tx: "0195f7ee-2be0-7e3c-b0ef-6cc3459b1d44",
  },
  {
    field: "isA",
    value: "spotify:album",
    tx: "0195f7eb-3385-7240-8cd3-70eb1f6a1211",
  },
];

const health = [
  { label: "consolidator", status: "healthy" },
  { label: "search", status: "indexing" },
  { label: "mcp", status: "offline" },
];

const factFeed = [
  {
    entity: "spotify:album:1xndb8d9an",
    field: "spotify:displayName",
    value: "2112",
    statedBy: "agent:spotify-importer",
  },
  {
    entity: "spotify:album:1xndb8d9an",
    field: "spotify:byArtist",
    value: "spotify:artist:2910301nxo",
    statedBy: "agent:spotify-importer",
  },
  {
    entity: "spotify:artist:2910301nxo",
    field: "spotify:displayName",
    value: "Rush",
    statedBy: "agent:discography-sync",
  },
];

export function App() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState<"entities" | "facts">("entities");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }

      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return searchEntries;
    }

    return searchEntries.filter((entry) => {
      return (
        entry.title.toLowerCase().includes(normalized) ||
        entry.meta.toLowerCase().includes(normalized) ||
        entry.kind.toLowerCase().includes(normalized)
      );
    });
  }, [query]);

  return (
    <>
      <ThemeRoot className="app-shell-root">
        <div className="app-shell">
          <aside className="sidebar">
            <div className="sidebar-topbar">
              <div className="sidebar-wordmark">Poneglyph.</div>
              <Button
                className="omnisearch-launch"
                onClick={() => setSearchOpen(true)}
                size="lg"
                tone="secondary"
              >
                <Kbd>⌘K</Kbd>
              </Button>
            </div>

            <nav className="sidebar-nav" aria-label="Workspace navigation">
              <div className="sidebar-section-label">Workspace</div>
              <NavItem
                active={activeSection === "entities"}
                onClick={() => setActiveSection("entities")}
                meta="Graph"
              >
                Entities
              </NavItem>
              <NavItem
                active={activeSection === "facts"}
                onClick={() => setActiveSection("facts")}
                meta="Log"
              >
                Facts
              </NavItem>
            </nav>

            {activeSection === "entities" ? (
              <Card className="sidebar-panel" density="compact">
                <div className="panel-heading">
                  <span>Entity explorer</span>
                  <Button size="sm" tone="ghost">
                    Open graph
                  </Button>
                </div>

                <div className="graph-frame" role="img" aria-label="Entity graph explorer">
                  <svg
                    aria-labelledby="entity-graph-title"
                    className="graph-svg"
                    viewBox="0 0 336 320"
                  >
                    <title id="entity-graph-title">Entity graph explorer</title>
                    {graphEdges.map(([from, to]) => {
                      const source = graphNodes.find((node) => node.id === from);
                      const target = graphNodes.find((node) => node.id === to);
                      if (!source || !target) {
                        return null;
                      }
                      return (
                        <line
                          key={`${from}-${to}`}
                          x1={source.x}
                          x2={target.x}
                          y1={source.y}
                          y2={target.y}
                          className="graph-edge"
                        />
                      );
                    })}

                    {graphNodes.map((node) => (
                      <g key={node.id}>
                        <circle
                          className={node.active ? "graph-node graph-node--active" : "graph-node"}
                          cx={node.x}
                          cy={node.y}
                          r={node.active ? 34 : 26}
                        />
                        <text className="graph-label" textAnchor="middle" x={node.x} y={node.y + 5}>
                          {node.label}
                        </text>
                      </g>
                    ))}
                  </svg>
                </div>

                <div className="graph-caption">
                  <strong>Focused entity</strong>
                  <p>`spotify:album:1xndb8d9an` connected to artist, search, and MCP surfaces.</p>
                </div>
              </Card>
            ) : (
              <Card className="sidebar-panel sidebar-panel--compact" density="compact">
                <div className="panel-heading">
                  <span>Runtime health</span>
                </div>

                <div className="status-list">
                  {health.map((item) => (
                    <div className="status-row" key={item.label}>
                      <StatusDot
                        tone={
                          item.status === "healthy"
                            ? "healthy"
                            : item.status === "indexing"
                              ? "warn"
                              : "offline"
                        }
                      />
                      <span>{item.label}</span>
                      <span className="status-text">{item.status}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </aside>

          <main className="main-pane">
            {activeSection === "entities" ? (
              <>
                <header className="main-header">
                  <div>
                    <span className="main-overline">Current entity</span>
                    <h2>spotify:album:1xndb8d9an</h2>
                  </div>

                  <div className="main-actions">
                    <Button className="action-button" tone="ghost">
                      Replay projection
                    </Button>
                    <Button className="action-button" tone="accent">
                      State fact
                    </Button>
                  </div>
                </header>

                <Card className="hero-card" density="comfortable">
                  <div className="hero-copy">
                    <Badge className="entity-chip">album</Badge>
                    <h3>2112</h3>
                    <p>
                      Consolidated from append-only facts. Strongly consistent fact reads, eventual
                      entity projections, and a graph layer waiting behind the daemon.
                    </p>
                  </div>

                  <dl className="hero-metrics">
                    <div>
                      <dt>Namespace</dt>
                      <dd>spotify</dd>
                    </div>
                    <div>
                      <dt>Last tx</dt>
                      <dd>0195f7ee…</dd>
                    </div>
                    <div>
                      <dt>Aliases</dt>
                      <dd>3 sameAs links</dd>
                    </div>
                  </dl>
                </Card>

                <div className="content-columns">
                  <Card className="content-card" density="compact">
                    <div className="panel-heading">
                      <span>Fact stream</span>
                      <span className="panel-meta">Newest wins in consolidation</span>
                    </div>

                    <div className="fact-list">
                      {facts.map((fact) => (
                        <article className="fact-row" key={`${fact.field}-${fact.tx}`}>
                          <div>
                            <strong>{fact.field}</strong>
                            <p>{fact.value}</p>
                          </div>
                          <span className="fact-tx">{fact.tx.slice(0, 12)}…</span>
                        </article>
                      ))}
                    </div>
                  </Card>

                  <Card className="content-card" density="compact">
                    <div className="panel-heading">
                      <span>Work queue</span>
                      <span className="panel-meta">Eventual read models</span>
                    </div>

                    <div className="queue-list">
                      <article className="queue-row">
                        <StatusDot tone="healthy" />
                        <div>
                          <strong>search projection</strong>
                          <p>Indexing this entity into Tantivy with keyword and URI facets.</p>
                        </div>
                      </article>
                      <article className="queue-row">
                        <StatusDot tone="warn" />
                        <div>
                          <strong>identity merge</strong>
                          <p>Reconciling `sameAs` aliases into one emergent object.</p>
                        </div>
                      </article>
                      <article className="queue-row">
                        <StatusDot tone="offline" />
                        <div>
                          <strong>mcp surface</strong>
                          <p>Will expose memory tools once the daemon bridge exists.</p>
                        </div>
                      </article>
                    </div>
                  </Card>
                </div>
              </>
            ) : (
              <>
                <header className="main-header">
                  <div>
                    <span className="main-overline">Fact log</span>
                    <h2>Append-only facts</h2>
                  </div>

                  <div className="main-actions">
                    <Button className="action-button" tone="ghost">
                      Filter stream
                    </Button>
                    <Button className="action-button" tone="accent">
                      New statement
                    </Button>
                  </div>
                </header>

                <Card className="hero-card" density="comfortable">
                  <div className="hero-copy">
                    <Badge className="entity-chip">transactional writes</Badge>
                    <h3>Everything starts as a fact.</h3>
                    <p>
                      This view is about raw evidence, provenance, and transaction order. Reads here
                      stay strongly consistent even while entities and projections lag behind.
                    </p>
                  </div>

                  <dl className="hero-metrics">
                    <div>
                      <dt>Last tx</dt>
                      <dd>0195f7ee…</dd>
                    </div>
                    <div>
                      <dt>Open replays</dt>
                      <dd>2 projections</dd>
                    </div>
                    <div>
                      <dt>Retractions</dt>
                      <dd>append-only</dd>
                    </div>
                  </dl>
                </Card>

                <div className="content-columns">
                  <Card className="content-card" density="compact">
                    <div className="panel-heading">
                      <span>Recent writes</span>
                      <span className="panel-meta">tx ordered</span>
                    </div>

                    <div className="fact-feed">
                      {factFeed.map((fact) => (
                        <article className="fact-feed-row" key={`${fact.entity}-${fact.field}`}>
                          <strong>{fact.entity}</strong>
                          <p>
                            <span className="fact-field">{fact.field}</span>
                            <span className="fact-arrow">→</span>
                            {fact.value}
                          </p>
                          <span className="fact-origin">{fact.statedBy}</span>
                        </article>
                      ))}
                    </div>
                  </Card>

                  <Card className="content-card" density="compact">
                    <div className="panel-heading">
                      <span>Read guarantees</span>
                      <span className="panel-meta">operational model</span>
                    </div>

                    <div className="queue-list">
                      <article className="queue-row">
                        <StatusDot tone="healthy" />
                        <div>
                          <strong>facts</strong>
                          <p>
                            Read-after-write consistent immediately after `state_facts` commits.
                          </p>
                        </div>
                      </article>
                      <article className="queue-row">
                        <StatusDot tone="warn" />
                        <div>
                          <strong>entities</strong>
                          <p>Consolidated asynchronously with deterministic merge rules.</p>
                        </div>
                      </article>
                      <article className="queue-row">
                        <StatusDot tone="offline" />
                        <div>
                          <strong>projections</strong>
                          <p>Replayable and idempotent, but intentionally eventual.</p>
                        </div>
                      </article>
                    </div>
                  </Card>
                </div>
              </>
            )}
          </main>
        </div>
        <CommandDialog
          closeLabel={<Kbd>esc</Kbd>}
          inputRef={searchInputRef}
          onOpenChange={setSearchOpen}
          onQueryChange={setQuery}
          open={searchOpen}
          placeholder="Search entities, fields, tx ids, or projections"
          query={query}
        >
          {filteredEntries.map((entry) => (
            <CommandItem
              key={entry.meta}
              meta={entry.meta}
              title={entry.title}
              trailing={entry.kind}
            />
          ))}
        </CommandDialog>
      </ThemeRoot>
    </>
  );
}
