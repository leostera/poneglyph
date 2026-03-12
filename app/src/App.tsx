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

type SectionId = "entities" | "facts" | "settings";

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

const settingsModules = [
  {
    id: "general",
    title: "General",
    summary: "Identity, startup behavior, and local instance defaults.",
    status: "healthy" as const,
    groups: [
      {
        title: "Instance identity",
        description: "How this local node presents itself to projections and connected agents.",
        rows: [
          { label: "Display name", value: "Leo's Poneglyph", hint: "Shown in local tooling" },
          { label: "Node URI", value: "poneglyph://leo-macbook", hint: "Stable local instance id" },
          {
            label: "Launch at login",
            value: "Enabled",
            hint: "Menu bar runtime starts automatically",
          },
        ],
      },
      {
        title: "Defaults",
        description: "Base behavior for fact entry and background services.",
        rows: [
          { label: "Default namespace", value: "spotify", hint: "Preselected in fact composer" },
          { label: "Fact ordering", value: "UUID v7", hint: "Total order over time" },
        ],
      },
    ],
  },
  {
    id: "storage",
    title: "Storage",
    summary: "Paths, retention, and replay-safe on-disk data for the local graph.",
    status: "healthy" as const,
    groups: [
      {
        title: "Fact store",
        description: "Primary durable storage for append-only facts and transaction metadata.",
        rows: [
          {
            label: "Root path",
            value: "~/Library/Application Support/Poneglyph",
            hint: "Managed by the desktop app",
          },
          { label: "Fact log", value: "facts.sqlite", hint: "Append-only SQLite store" },
          { label: "Compaction", value: "None", hint: "Facts are never rewritten" },
        ],
      },
      {
        title: "Backups",
        description: "Recovery and export configuration for local durability.",
        rows: [
          { label: "Snapshots", value: "Daily", hint: "Retain 14 rolling snapshots" },
          { label: "Exports", value: "Disabled", hint: "No external sync target yet" },
        ],
      },
    ],
  },
  {
    id: "projections",
    title: "Projections",
    summary: "Manage replay, isolation, and health for async downstream systems.",
    status: "warn" as const,
    groups: [
      {
        title: "Search",
        description: "Tantivy-backed full text and field-aware lookup derived from entities.",
        rows: [
          { label: "Index location", value: "search/", hint: "Lives beside the fact store" },
          { label: "Replay mode", value: "Idempotent", hint: "Safe to rebuild from tx 0" },
          { label: "Current lag", value: "12 entities", hint: "Within expected window" },
        ],
      },
      {
        title: "Enrichers",
        description: "External workers that observe graph facts and feed new facts back in.",
        rows: [
          { label: "imdb-rater", value: "Paused", hint: "API token missing" },
          { label: "spotify-importer", value: "Healthy", hint: "Polling every 10m" },
        ],
      },
    ],
  },
  {
    id: "mcp",
    title: "MCP access",
    summary: "Expose this local memory node to agents through a controlled MCP surface.",
    status: "offline" as const,
    groups: [
      {
        title: "Server endpoints",
        description: "Transport configuration for local agents and tools.",
        rows: [
          { label: "stdio", value: "Enabled", hint: "Default local transport" },
          { label: "Unix socket", value: "Disabled", hint: "Not yet configured" },
          { label: "localhost HTTP", value: "Disabled", hint: "Reserved for later" },
        ],
      },
      {
        title: "Permissions",
        description: "Local access policy until per-agent auth is implemented.",
        rows: [
          { label: "Write access", value: "Open", hint: "Any local agent may state facts" },
          { label: "Authority rules", value: "Planned", hint: "Not enforced yet" },
        ],
      },
    ],
  },
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
  const [selectedSettingsId, setSelectedSettingsId] = useState(settingsModules[0]?.id ?? "");
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
  const selectedSettings =
    settingsModules.find((module) => module.id === selectedSettingsId) ?? settingsModules[0];

  return (
    <ThemeRoot>
      <div className="desktop-frame">
        <div className="workspace-shell">
          <aside className="left-rail">
            <div className="workspace-switcher">
              <div className="workspace-wordmark">Poneglyph.</div>
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
                  onClick={() => setActiveSection("entities")}
                >
                  <span className="nav-entry">
                    <span className="nav-entry__icon">
                      <EntitiesIcon />
                    </span>
                    <span className="nav-entry__label">Entities</span>
                  </span>
                </NavItem>
                <NavItem
                  active={activeSection === "facts"}
                  onClick={() => setActiveSection("facts")}
                >
                  <span className="nav-entry">
                    <span className="nav-entry__icon">
                      <FactsIcon />
                    </span>
                    <span className="nav-entry__label">Facts</span>
                  </span>
                </NavItem>
                <NavItem
                  active={activeSection === "settings"}
                  onClick={() => setActiveSection("settings")}
                >
                  <span className="nav-entry">
                    <span className="nav-entry__icon">
                      <SettingsIcon />
                    </span>
                    <span className="nav-entry__label">Settings</span>
                  </span>
                </NavItem>
              </div>
            </div>
          </aside>

          <section className="browser-pane">
            <header className="pane-header">
              <div>
                <div className="pane-eyebrow">
                  {activeSection === "entities"
                    ? "Entity explorer"
                    : activeSection === "facts"
                      ? "Fact log"
                      : "Configuration"}
                </div>
                <h2 className="pane-title">
                  {activeSection === "entities"
                    ? "Entities"
                    : activeSection === "facts"
                      ? "Transactions"
                      : "Settings"}
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
                : activeSection === "facts"
                  ? factBatches.map((fact) => (
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
                    ))
                  : settingsModules.map((module) => (
                      <button
                        className={
                          module.id === selectedSettingsId
                            ? "browser-item browser-item--active"
                            : "browser-item"
                        }
                        key={module.id}
                        onClick={() => setSelectedSettingsId(module.id)}
                        type="button"
                      >
                        <div className="browser-item__header">
                          <span className="browser-item__title">{module.title}</span>
                          <StatusDot tone={module.status} />
                        </div>
                        <div className="browser-item__meta">
                          <span>{module.groups.length} modules</span>
                          <span>operator surface</span>
                        </div>
                        <p className="browser-item__summary">{module.summary}</p>
                        <span className="browser-item__uri">{module.id}</span>
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
            ) : activeSection === "facts" && selectedFact ? (
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
            ) : activeSection === "settings" && selectedSettings ? (
              <>
                <header className="detail-header">
                  <div className="detail-header__title">
                    <div className="detail-header__eyebrow">Settings module</div>
                    <h1>{selectedSettings.title}</h1>
                    <p>{selectedSettings.summary}</p>
                  </div>
                  <div className="detail-header__actions">
                    <Button tone="ghost">Reset</Button>
                    <Button tone="accent">Apply changes</Button>
                  </div>
                </header>

                <div className="detail-body">
                  <section className="detail-hero">
                    <div className="detail-hero__copy">
                      <Badge>modular settings</Badge>
                      <p>
                        Configure this local Poneglyph instance by capability: identity, storage,
                        projections, and agent access each live in their own module.
                      </p>
                    </div>
                    <dl className="detail-stats">
                      <div>
                        <dt>Module</dt>
                        <dd>{selectedSettings.title}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{selectedSettings.status}</dd>
                      </div>
                      <div>
                        <dt>Cards</dt>
                        <dd>{selectedSettings.groups.length}</dd>
                      </div>
                    </dl>
                  </section>

                  <div className="settings-grid">
                    {selectedSettings.groups.map((group) => (
                      <section className="detail-card settings-card" key={group.title}>
                        <div className="detail-card__header">
                          <span>{group.title}</span>
                          <span>{group.rows.length} controls</span>
                        </div>
                        <p className="settings-card__description">{group.description}</p>
                        <div className="settings-rows">
                          {group.rows.map((row) => (
                            <div className="settings-row" key={row.label}>
                              <div className="settings-row__info">
                                <strong>{row.label}</strong>
                                <p>{row.hint}</p>
                              </div>
                              <div className="settings-row__value">{row.value}</div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
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

function EntitiesIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="4" cy="4" fill="none" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="4" fill="none" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="11.5" fill="none" r="2.1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.7 5.5 7.1 9M10.3 5.5 8.9 9" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function FactsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M4.25 2.75h5.7l2.05 2.1v8.4H4.25z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
      <path
        d="M9.95 2.75v2.1H12"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
      <path
        d="M6.25 8h3.6M6.25 10.75h3.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="8" cy="8" fill="none" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 2.3v1.5M8 12.2v1.5M13.7 8h-1.5M3.8 8H2.3M11.95 4.05l-1.05 1.05M5.1 10.9l-1.05 1.05M11.95 11.95 10.9 10.9M5.1 5.1 4.05 4.05"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}
