import {
  Badge,
  Button,
  CommandDialog,
  CommandItem,
  Kbd,
  NavItem,
  StatusDot,
  ThemeRoot,
} from "@poneglyph/ui";
import { useEffect, useMemo, useRef, useState } from "react";

type SectionId = "entities" | "facts";

const entities = [
  {
    id: "spotify:album:1xndb8d9an",
    title: "2112",
    kind: "album",
    namespace: "spotify",
    summary: "Rush studio album with stable identity links and active search projection.",
    status: "healthy" as const,
    updatedAt: "2m ago",
    fields: [
      ["spotify:displayName", "2112"],
      ["spotify:byArtist", "spotify:artist:2910301nxo"],
      ["isA", "spotify:album"],
      ["sameAs", "musicbrainz:release-group:3f1a"],
    ],
    relations: [
      { label: "By artist", value: "Rush" },
      { label: "Projected to", value: "Search" },
      { label: "Served through", value: "MCP" },
    ],
  },
  {
    id: "spotify:artist:2910301nxo",
    title: "Rush",
    kind: "artist",
    namespace: "spotify",
    summary: "Canonical artist entity merged from Spotify and discography sync facts.",
    status: "healthy" as const,
    updatedAt: "6m ago",
    fields: [
      ["spotify:displayName", "Rush"],
      ["isA", "spotify:artist"],
      ["sameAs", "wikidata:Q5244"],
    ],
    relations: [
      { label: "Creates", value: "2112" },
      { label: "Seen by", value: "Search" },
      { label: "Imported by", value: "discography-sync" },
    ],
  },
  {
    id: "imdb:title:tt0080684",
    title: "The Empire Strikes Back",
    kind: "title",
    namespace: "imdb",
    summary: "External projection target waiting on the imdb-rater enrichment worker.",
    status: "warn" as const,
    updatedAt: "14m ago",
    fields: [
      ["imdb:canonicalUrl", "https://www.imdb.com/title/tt0080684"],
      ["imdb:rating", "8.7"],
      ["isA", "imdb:title"],
    ],
    relations: [
      { label: "Queued for", value: "imdb-rater" },
      { label: "Projected to", value: "Search" },
      { label: "Last tx", value: "0195f7ee" },
    ],
  },
];

const factBatches = [
  {
    id: "0195f7ee-2be0-7e3c-b0ef-6cc3459b1d44",
    entity: "spotify:album:1xndb8d9an",
    title: "Album facts for 2112",
    statedBy: "agent:spotify-importer",
    status: "healthy" as const,
    statedAt: "09:42",
    facts: [
      ["spotify:displayName", "2112"],
      ["spotify:byArtist", "spotify:artist:2910301nxo"],
      ["spotify:releaseYear", "1976"],
    ],
  },
  {
    id: "0195f7ed-6b95-7c42-84d4-23f1aee4bf18",
    entity: "spotify:artist:2910301nxo",
    title: "Artist refresh from discography sync",
    statedBy: "agent:discography-sync",
    status: "healthy" as const,
    statedAt: "09:34",
    facts: [
      ["spotify:displayName", "Rush"],
      ["sameAs", "wikidata:Q5244"],
    ],
  },
  {
    id: "0195f7eb-3385-7240-8cd3-70eb1f6a1211",
    entity: "imdb:title:tt0080684",
    title: "IMDb title bootstrap",
    statedBy: "agent:imdb-rater",
    status: "warn" as const,
    statedAt: "09:12",
    facts: [
      ["imdb:canonicalUrl", "https://www.imdb.com/title/tt0080684"],
      ["isA", "imdb:title"],
    ],
  },
];

const runtimeCards = [
  {
    label: "Facts",
    value: "16,428",
    meta: "strongly consistent",
  },
  {
    label: "Entities",
    value: "2,031",
    meta: "eventual views",
  },
  {
    label: "Projections",
    value: "4",
    meta: "idempotent replay",
  },
];

const runtimeHealth = [
  { label: "consolidator", status: "healthy" as const, detail: "Lag 2 entities" },
  { label: "search", status: "healthy" as const, detail: "Tantivy current" },
  { label: "imdb-rater", status: "warn" as const, detail: "34 queued fetches" },
  { label: "mcp", status: "offline" as const, detail: "No clients attached" },
];

const searchEntries = [
  {
    title: "2112",
    meta: "spotify:album:1xndb8d9an",
    kind: "entity",
  },
  {
    title: "Rush",
    meta: "spotify:artist:2910301nxo",
    kind: "entity",
  },
  {
    title: "0195f7ee-2be0-7e3c-b0ef-6cc3459b1d44",
    meta: "fact transaction",
    kind: "tx",
  },
  {
    title: "Replay search projection",
    meta: "runtime action",
    kind: "command",
  },
];

export function App() {
  const [activeSection, setActiveSection] = useState<SectionId>("entities");
  const [selectedEntityId, setSelectedEntityId] = useState(entities[0]?.id ?? "");
  const [selectedFactId, setSelectedFactId] = useState(factBatches[0]?.id ?? "");
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

  const selectedEntity = entities.find((entity) => entity.id === selectedEntityId) ?? entities[0];
  const selectedFact = factBatches.find((fact) => fact.id === selectedFactId) ?? factBatches[0];

  return (
    <ThemeRoot>
      <div className="desktop-frame">
        <div className="workspace-shell">
          <aside className="left-rail">
            <div className="left-rail__window">
              <div className="traffic-lights">
                <span className="traffic traffic--close" />
                <span className="traffic traffic--min" />
                <span className="traffic traffic--max" />
              </div>
              <div className="rail-top-actions">
                <button className="rail-icon-button" type="button" aria-label="Back">
                  <ArrowLeftIcon />
                </button>
                <button className="rail-icon-button" type="button" aria-label="Forward">
                  <ArrowRightIcon />
                </button>
                <button className="rail-icon-button" type="button" aria-label="History">
                  <ClockIcon />
                </button>
              </div>
            </div>

            <div className="workspace-switcher">
              <div>
                <div className="workspace-wordmark">Poneglyph.</div>
                <div className="workspace-subtitle">Absolute local memory</div>
              </div>
              <Button
                className="search-launch"
                onClick={() => setSearchOpen(true)}
                size="sm"
                tone="secondary"
              >
                <Kbd>Cmd K</Kbd>
              </Button>
            </div>

            <div className="rail-section">
              <div className="rail-section__label">Workspace</div>
              <div className="rail-nav">
                <NavItem
                  active={activeSection === "entities"}
                  meta="graph"
                  onClick={() => setActiveSection("entities")}
                >
                  Entities
                </NavItem>
                <NavItem
                  active={activeSection === "facts"}
                  meta="log"
                  onClick={() => setActiveSection("facts")}
                >
                  Facts
                </NavItem>
              </div>
            </div>

            <div className="rail-section">
              <div className="rail-section__label">Runtime</div>
              <div className="rail-metrics">
                {runtimeCards.map((card) => (
                  <article className="metric-tile" key={card.label}>
                    <div className="metric-tile__value">{card.value}</div>
                    <div className="metric-tile__label">{card.label}</div>
                    <div className="metric-tile__meta">{card.meta}</div>
                  </article>
                ))}
              </div>
            </div>

            <div className="rail-section rail-section--grow">
              <div className="rail-section__label">Projection health</div>
              <div className="health-list">
                {runtimeHealth.map((item) => (
                  <article className="health-row" key={item.label}>
                    <div className="health-row__left">
                      <StatusDot tone={item.status} />
                      <span>{item.label}</span>
                    </div>
                    <span className="health-row__detail">{item.detail}</span>
                  </article>
                ))}
              </div>
            </div>
          </aside>

          <section className="browser-pane">
            <header className="pane-header">
              <div>
                <div className="pane-eyebrow">
                  {activeSection === "entities" ? "Entity explorer" : "Fact log"}
                </div>
                <h2 className="pane-title">
                  {activeSection === "entities" ? "Entities" : "Transactions"}
                </h2>
              </div>
              <div className="pane-header__actions">
                <button className="rail-icon-button" type="button" aria-label="Filter">
                  <FilterIcon />
                </button>
                <button className="rail-icon-button" type="button" aria-label="Tune">
                  <TuneIcon />
                </button>
              </div>
            </header>

            <div className="browser-list">
              {activeSection === "entities"
                ? entities.map((entity) => (
                    <button
                      className={
                        entity.id === selectedEntityId
                          ? "browser-item browser-item--active"
                          : "browser-item"
                      }
                      key={entity.id}
                      onClick={() => setSelectedEntityId(entity.id)}
                      type="button"
                    >
                      <div className="browser-item__header">
                        <span className="browser-item__title">{entity.title}</span>
                        <StatusDot tone={entity.status} />
                      </div>
                      <div className="browser-item__meta">
                        <Badge>{entity.kind}</Badge>
                        <span>{entity.updatedAt}</span>
                      </div>
                      <p className="browser-item__summary">{entity.summary}</p>
                      <span className="browser-item__uri">{entity.id}</span>
                    </button>
                  ))
                : factBatches.map((fact) => (
                    <button
                      className={
                        fact.id === selectedFactId
                          ? "browser-item browser-item--active"
                          : "browser-item"
                      }
                      key={fact.id}
                      onClick={() => setSelectedFactId(fact.id)}
                      type="button"
                    >
                      <div className="browser-item__header">
                        <span className="browser-item__title">{fact.title}</span>
                        <StatusDot tone={fact.status} />
                      </div>
                      <div className="browser-item__meta">
                        <span>{fact.statedAt}</span>
                        <span>{fact.statedBy}</span>
                      </div>
                      <p className="browser-item__summary">{fact.entity}</p>
                      <span className="browser-item__uri">{fact.id}</span>
                    </button>
                  ))}
            </div>
          </section>

          <section className="detail-pane">
            {activeSection === "entities" && selectedEntity ? (
              <>
                <header className="detail-header">
                  <div className="detail-header__title">
                    <div className="detail-header__eyebrow">Entity</div>
                    <h1>{selectedEntity.title}</h1>
                    <p>{selectedEntity.id}</p>
                  </div>
                  <div className="detail-header__actions">
                    <Button tone="ghost">Replay</Button>
                    <Button tone="accent">State fact</Button>
                  </div>
                </header>

                <div className="detail-body">
                  <section className="detail-hero">
                    <div className="detail-hero__copy">
                      <Badge>{selectedEntity.namespace}</Badge>
                      <p>{selectedEntity.summary}</p>
                    </div>
                    <dl className="detail-stats">
                      <div>
                        <dt>Namespace</dt>
                        <dd>{selectedEntity.namespace}</dd>
                      </div>
                      <div>
                        <dt>Kind</dt>
                        <dd>{selectedEntity.kind}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>{selectedEntity.updatedAt}</dd>
                      </div>
                    </dl>
                  </section>

                  <div className="detail-grid">
                    <section className="detail-card">
                      <div className="detail-card__header">
                        <span>Consolidated fields</span>
                        <span>new fact wins</span>
                      </div>
                      <div className="field-table">
                        {selectedEntity.fields.map(([field, value]) => (
                          <div className="field-row" key={field}>
                            <dt>{field}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="detail-card">
                      <div className="detail-card__header">
                        <span>Entity graph</span>
                        <span>focused neighborhood</span>
                      </div>
                      <div className="graph-panel">
                        <svg
                          aria-label="Focused entity graph neighborhood"
                          className="graph-panel__svg"
                          role="img"
                          viewBox="0 0 420 220"
                        >
                          <title>Focused entity graph neighborhood</title>
                          <line className="graph-line" x1="210" x2="94" y1="76" y2="154" />
                          <line className="graph-line" x1="210" x2="326" y1="76" y2="154" />
                          <line className="graph-line" x1="210" x2="210" y1="76" y2="170" />
                          <circle
                            className="graph-node graph-node--primary"
                            cx="210"
                            cy="76"
                            r="34"
                          />
                          <circle className="graph-node" cx="94" cy="154" r="26" />
                          <circle className="graph-node" cx="326" cy="154" r="26" />
                          <circle className="graph-node" cx="210" cy="170" r="24" />
                          <text className="graph-text" textAnchor="middle" x="210" y="81">
                            {selectedEntity.title}
                          </text>
                          <text className="graph-text" textAnchor="middle" x="94" y="159">
                            Rush
                          </text>
                          <text className="graph-text" textAnchor="middle" x="326" y="159">
                            Search
                          </text>
                          <text className="graph-text" textAnchor="middle" x="210" y="175">
                            MCP
                          </text>
                        </svg>
                      </div>
                      <div className="relation-list">
                        {selectedEntity.relations.map((relation) => (
                          <div className="relation-pill" key={relation.label}>
                            <span>{relation.label}</span>
                            <strong>{relation.value}</strong>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </div>
              </>
            ) : selectedFact ? (
              <>
                <header className="detail-header">
                  <div className="detail-header__title">
                    <div className="detail-header__eyebrow">Transaction</div>
                    <h1>{selectedFact.title}</h1>
                    <p>{selectedFact.id}</p>
                  </div>
                  <div className="detail-header__actions">
                    <Button tone="ghost">Filter stream</Button>
                    <Button tone="accent">Append facts</Button>
                  </div>
                </header>

                <div className="detail-body">
                  <section className="detail-hero">
                    <div className="detail-hero__copy">
                      <Badge>append-only</Badge>
                      <p>
                        Facts are the durable record. Entity consolidation and projections lag
                        behind on purpose, but reads over the fact log remain immediate.
                      </p>
                    </div>
                    <dl className="detail-stats">
                      <div>
                        <dt>Entity</dt>
                        <dd>{selectedFact.entity}</dd>
                      </div>
                      <div>
                        <dt>Stated by</dt>
                        <dd>{selectedFact.statedBy}</dd>
                      </div>
                      <div>
                        <dt>Time</dt>
                        <dd>{selectedFact.statedAt}</dd>
                      </div>
                    </dl>
                  </section>

                  <div className="detail-grid detail-grid--single">
                    <section className="detail-card">
                      <div className="detail-card__header">
                        <span>Facts in transaction</span>
                        <span>{selectedFact.facts.length} atomic writes</span>
                      </div>
                      <div className="field-table">
                        {selectedFact.facts.map(([field, value]) => (
                          <div className="field-row" key={field}>
                            <dt>{field}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </div>

        <CommandDialog
          closeLabel={<Kbd>Esc</Kbd>}
          inputRef={searchInputRef}
          onOpenChange={setSearchOpen}
          onQueryChange={setQuery}
          open={searchOpen}
          placeholder="Search entities, tx ids, fields, or commands"
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
      </div>
    </ThemeRoot>
  );
}

function ArrowLeftIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M9.75 3.5 5.25 8l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M6.25 3.5 10.75 8l-4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="8" cy="8" fill="none" r="5.75" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 4.7v3.55l2.35 1.25"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M2.5 4h11M4.75 8h6.5M6.75 12h2.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function TuneIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M3 4h10M3 8h10M3 12h10"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
      <circle cx="6" cy="4" fill="currentColor" r="1.3" />
      <circle cx="10" cy="8" fill="currentColor" r="1.3" />
      <circle cx="7" cy="12" fill="currentColor" r="1.3" />
    </svg>
  );
}
