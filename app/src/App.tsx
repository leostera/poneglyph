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

export function App() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
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
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="sidebar-eyebrow">Poneglyph.app</span>
            <h1>Absolute memory.</h1>
            <p>Fact-first memory with emergent entities, projections, and a local agent runtime.</p>
          </div>

          <button className="omnisearch-launch" type="button" onClick={() => setSearchOpen(true)}>
            <span className="omnisearch-copy">Search entities, facts, or runtime state</span>
            <span className="omnisearch-shortcut">⌘K</span>
          </button>

          <section className="sidebar-panel">
            <div className="panel-heading">
              <span>Entity explorer</span>
              <button className="panel-link" type="button">
                Open graph
              </button>
            </div>

            <div className="graph-frame" role="img" aria-label="Entity graph explorer">
              <svg aria-labelledby="entity-graph-title" className="graph-svg" viewBox="0 0 336 320">
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
          </section>

          <section className="sidebar-panel sidebar-panel--compact">
            <div className="panel-heading">
              <span>Runtime health</span>
            </div>

            <div className="status-list">
              {health.map((item) => (
                <div className="status-row" key={item.label}>
                  <span className={`status-dot status-dot--${item.status}`} />
                  <span>{item.label}</span>
                  <span className="status-text">{item.status}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <main className="main-pane">
          <header className="main-header">
            <div>
              <span className="main-overline">Current focus</span>
              <h2>spotify:album:1xndb8d9an</h2>
            </div>

            <div className="main-actions">
              <button className="action-button action-button--ghost" type="button">
                Replay projection
              </button>
              <button className="action-button" type="button">
                State fact
              </button>
            </div>
          </header>

          <section className="hero-card">
            <div className="hero-copy">
              <span className="entity-chip">album</span>
              <h3>2112</h3>
              <p>
                Consolidated from append-only facts. Strongly consistent fact reads, eventual entity
                projections, and a graph layer waiting behind the daemon.
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
          </section>

          <div className="content-columns">
            <section className="content-card">
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
            </section>

            <section className="content-card">
              <div className="panel-heading">
                <span>Work queue</span>
                <span className="panel-meta">Eventual read models</span>
              </div>

              <div className="queue-list">
                <article className="queue-row">
                  <span className="status-dot status-dot--healthy" />
                  <div>
                    <strong>search projection</strong>
                    <p>Indexing this entity into Tantivy with keyword and URI facets.</p>
                  </div>
                </article>
                <article className="queue-row">
                  <span className="status-dot status-dot--indexing" />
                  <div>
                    <strong>identity merge</strong>
                    <p>Reconciling `sameAs` aliases into one emergent object.</p>
                  </div>
                </article>
                <article className="queue-row">
                  <span className="status-dot status-dot--offline" />
                  <div>
                    <strong>mcp surface</strong>
                    <p>Will expose memory tools once the daemon bridge exists.</p>
                  </div>
                </article>
              </div>
            </section>
          </div>
        </main>
      </div>

      {searchOpen ? (
        <div className="search-overlay">
          <button
            aria-label="Close omnisearch"
            className="search-overlay-dismiss"
            onClick={() => setSearchOpen(false)}
            type="button"
          />
          <dialog
            aria-label="Omnisearch"
            className="search-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            open
          >
            <div className="search-input-row">
              <input
                className="search-input"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search entities, fields, tx ids, or projections"
                ref={searchInputRef}
                value={query}
              />
              <button className="search-close" type="button" onClick={() => setSearchOpen(false)}>
                esc
              </button>
            </div>

            <div className="search-results">
              {filteredEntries.map((entry) => (
                <button className="search-result" key={entry.meta} type="button">
                  <div>
                    <strong>{entry.title}</strong>
                    <p>{entry.meta}</p>
                  </div>
                  <span>{entry.kind}</span>
                </button>
              ))}
            </div>
          </dialog>
        </div>
      ) : null}
    </>
  );
}
