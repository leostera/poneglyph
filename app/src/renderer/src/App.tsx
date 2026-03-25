import { Badge, Button, StatusDot, ThemeRoot } from "@poneglyph/ui";
import { type ReactNode, useEffect, useEffectEvent, useMemo, useState } from "react";

type BannerTone = "info" | "success" | "error";

type Banner = {
  tone: BannerTone;
  message: string;
} | null;

type ConnectorName = "plex" | "gcal";

type ConnectorStatus = {
  name: ConnectorName;
  enabled: boolean;
  connected: boolean;
  selectedResourceCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
};

type GoogleCalendarResource = {
  calendarId: string;
  summary: string;
  description: string | null;
  timeZone: string | null;
  primary: boolean;
  selected: boolean;
};

type ConnectorSyncResult = {
  name: ConnectorName;
  synced: boolean;
  message: string;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

export function App() {
  return (
    <ThemeRoot>
      <ConnectorsWorkspace />
    </ThemeRoot>
  );
}

function ConnectorsWorkspace() {
  const [connectorStatuses, setConnectorStatuses] = useState<ConnectorStatus[]>([]);
  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendarResource[]>([]);
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);
  const [banner, setBanner] = useState<Banner>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isSavingGoogleSelection, setIsSavingGoogleSelection] = useState(false);
  const [syncingConnector, setSyncingConnector] = useState<ConnectorName | null>(null);
  const [pendingGoogleAuth, setPendingGoogleAuth] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  const googleStatus = useMemo(
    () => connectorStatuses.find((status) => status.name === "gcal") ?? null,
    [connectorStatuses],
  );
  const plexStatus = useMemo(
    () => connectorStatuses.find((status) => status.name === "plex") ?? null,
    [connectorStatuses],
  );

  function syncSelectedCalendars(calendars: GoogleCalendarResource[]) {
    setGoogleCalendars(calendars);
    setSelectedCalendarIds(
      calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.calendarId),
    );
  }

  const refreshWorkspace = useEffectEvent(async (quiet = false) => {
    if (!quiet) {
      setIsRefreshing(true);
      setBanner(null);
    }

    try {
      const statuses = await getConnectorStatuses();
      setConnectorStatuses(statuses);

      const nextGoogleStatus = statuses.find((status) => status.name === "gcal");
      if (nextGoogleStatus?.connected) {
        let calendars = await getGoogleCalendars();
        if (pendingGoogleAuth && calendars.length === 0) {
          calendars = await discoverGoogleCalendarsMutation();
          setBanner({
            tone: "success",
            message: `Google connected. Discovered ${calendars.length} calendar${calendars.length === 1 ? "" : "s"}.`,
          });
        } else if (pendingGoogleAuth) {
          setBanner({
            tone: "success",
            message: "Google connected. Your local app is ready to select calendars.",
          });
        }

        syncSelectedCalendars(calendars);
        if (pendingGoogleAuth) {
          setPendingGoogleAuth(false);
        }
      } else {
        setGoogleCalendars([]);
        setSelectedCalendarIds([]);
      }

      setLastRefreshedAt(
        new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date()),
      );
    } catch (error) {
      if (!quiet) {
        setBanner({
          tone: "error",
          message: formatError(error, "Failed to reach the local Poneglyph API."),
        });
      }
    } finally {
      setIsRefreshing(false);
      setIsBooting(false);
    }
  });

  useEffect(() => {
    void refreshWorkspace();

    const intervalId = window.setInterval(() => {
      void refreshWorkspace(true);
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshWorkspace]);

  const openGoogleAuth = useEffectEvent(async () => {
    setPendingGoogleAuth(true);
    setBanner({
      tone: "info",
      message:
        "Finish the Google sign-in flow in your browser. This screen will refresh automatically.",
    });

    try {
      window.open(`${window.poneglyph.apiBaseUrl}/auth/google/login`, "_blank", "noopener");
    } catch (error) {
      setPendingGoogleAuth(false);
      setBanner({
        tone: "error",
        message: formatError(error, "Failed to open Google sign-in."),
      });
    }
  });

  const discoverGoogleCalendars = useEffectEvent(async () => {
    setIsDiscovering(true);
    setBanner(null);

    try {
      const calendars = await discoverGoogleCalendarsMutation();
      syncSelectedCalendars(calendars);
      setBanner({
        tone: "success",
        message: `Discovered ${calendars.length} Google calendar${calendars.length === 1 ? "" : "s"}.`,
      });
      await refreshWorkspace(true);
    } catch (error) {
      setBanner({
        tone: "error",
        message: formatError(error, "Failed to discover Google calendars."),
      });
    } finally {
      setIsDiscovering(false);
    }
  });

  const saveGoogleSelection = useEffectEvent(async () => {
    setIsSavingGoogleSelection(true);
    setBanner(null);

    try {
      const calendars = await selectGoogleCalendarsMutation(selectedCalendarIds);
      syncSelectedCalendars(calendars);
      setBanner({
        tone: "success",
        message: `Saved ${selectedCalendarIds.length} Google calendar selection${selectedCalendarIds.length === 1 ? "" : "s"}.`,
      });
      await refreshWorkspace(true);
    } catch (error) {
      setBanner({
        tone: "error",
        message: formatError(error, "Failed to save Google calendar selection."),
      });
    } finally {
      setIsSavingGoogleSelection(false);
    }
  });

  const syncNow = useEffectEvent(async (name: ConnectorName) => {
    setSyncingConnector(name);
    setBanner(null);

    try {
      const result = await syncConnectorMutation(name);
      setBanner({
        tone: result.synced ? "success" : "error",
        message: result.message,
      });
      await refreshWorkspace(true);
    } catch (error) {
      setBanner({
        tone: "error",
        message: formatError(error, `Failed to sync ${name}.`),
      });
    } finally {
      setSyncingConnector(null);
    }
  });

  function toggleCalendarSelection(calendarId: string) {
    setSelectedCalendarIds((current) => {
      if (current.includes(calendarId)) {
        return current.filter((id) => id !== calendarId);
      }
      return [...current, calendarId];
    });
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <div aria-hidden="true" className="app-brand__logo">
            P
          </div>
          <div>
            <p className="app-brand__eyebrow">Desktop</p>
            <h1 className="app-brand__wordmark">Poneglyph.</h1>
          </div>
        </div>

        <nav className="app-nav" aria-label="Primary">
          <button className="app-nav__item app-nav__item--active" type="button">
            <span className="app-nav__icon">
              <ConnectorsIcon />
            </span>
            <span>
              <strong>Connectors</strong>
              <small>Plex and Google Calendar</small>
            </span>
          </button>
          <button className="app-nav__item" disabled type="button">
            <span className="app-nav__icon">
              <PulseIcon />
            </span>
            <span>
              <strong>Activity</strong>
              <small>Coming soon</small>
            </span>
          </button>
          <button className="app-nav__item" disabled type="button">
            <span className="app-nav__icon">
              <GraphIcon />
            </span>
            <span>
              <strong>Graph</strong>
              <small>Coming soon</small>
            </span>
          </button>
        </nav>

        <div className="sidebar-card">
          <div className="sidebar-card__label">Runtime</div>
          <div className="sidebar-card__value">{window.poneglyph.apiBaseUrl}</div>
          <p>The desktop app is talking to your local daemon over the API surface.</p>
        </div>

        <div className="sidebar-card">
          <div className="sidebar-card__label">Environment</div>
          <dl className="sidebar-meta">
            <div>
              <dt>Platform</dt>
              <dd>{window.poneglyph.platform}</dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{window.poneglyph.version}</dd>
            </div>
            <div>
              <dt>Last refresh</dt>
              <dd>{lastRefreshedAt ?? "Waiting..."}</dd>
            </div>
          </dl>
        </div>
      </aside>

      <main className="app-main">
        <header className="page-header">
          <div>
            <p className="page-header__eyebrow">Local-first connector control</p>
            <h2 className="page-header__title">Connectors</h2>
            <p className="page-header__summary">
              Bring Google Calendar and Plex into your local graph. Auth stays in the browser;
              discovery, selection, and sync happen here.
            </p>
          </div>
          <div className="page-header__actions">
            <Button onClick={() => void refreshWorkspace()} tone="secondary">
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </header>

        {banner ? <output className={`banner banner--${banner.tone}`}>{banner.message}</output> : null}

        <section className="overview-grid">
          <OverviewCard
            label="Google Calendar"
            status={googleStatus}
            summary={
              googleStatus?.connected
                ? `${googleStatus.selectedResourceCount} selected calendar${googleStatus.selectedResourceCount === 1 ? "" : "s"}`
                : "Not connected yet"
            }
          />
          <OverviewCard
            label="Plex"
            status={plexStatus}
            summary={
              plexStatus?.enabled
                ? `${plexStatus.selectedResourceCount} configured librar${plexStatus.selectedResourceCount === 1 ? "y" : "ies"}`
                : "Disabled in config"
            }
          />
          <OverviewCard
            label="Local API"
            status={{
              name: "plex",
              enabled: true,
              connected: !isBooting,
              selectedResourceCount: 0,
              lastSyncedAt: null,
              lastError: null,
            }}
            summary={window.poneglyph.apiBaseUrl}
          />
        </section>

        <div className="connectors-grid">
          <section className="panel panel--primary">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">OAuth-backed connector</div>
                <h3>Google Calendar</h3>
              </div>
              <StatusBadge status={googleStatus} />
            </div>

            <p className="panel__summary">
              Connect your Google account, discover calendars, choose what belongs in sync, then
              materialize events into facts.
            </p>

            <div className="step-list">
              <ConnectorStep
                action={
                  <Button onClick={() => void openGoogleAuth()} tone="accent">
                    {pendingGoogleAuth ? "Waiting for sign-in..." : "Connect Google"}
                  </Button>
                }
                description="Open the browser OAuth flow and persist the connection locally."
                title="1. Authorize"
              />
              <ConnectorStep
                action={
                  <Button
                    disabled={!googleStatus?.connected || isDiscovering}
                    onClick={() => void discoverGoogleCalendars()}
                    tone="secondary"
                  >
                    {isDiscovering ? "Discovering..." : "Discover calendars"}
                  </Button>
                }
                description="Load the calendars visible to this connection into the local control plane."
                title="2. Discover"
              />
              <ConnectorStep
                action={
                  <Button
                    disabled={!googleCalendars.length || isSavingGoogleSelection}
                    onClick={() => void saveGoogleSelection()}
                    tone="secondary"
                  >
                    {isSavingGoogleSelection ? "Saving..." : "Save selection"}
                  </Button>
                }
                description="Choose which calendars should stay in sync with your local graph."
                title="3. Select"
              />
              <ConnectorStep
                action={
                  <Button
                    disabled={!googleStatus?.selectedResourceCount || syncingConnector === "gcal"}
                    onClick={() => void syncNow("gcal")}
                    tone="accent"
                  >
                    {syncingConnector === "gcal" ? "Syncing..." : "Sync now"}
                  </Button>
                }
                description="Pull events for the selected calendars and state them as facts."
                title="4. Sync"
              />
            </div>

            <div className="calendar-section">
              <div className="section-header">
                <div>
                  <div className="section-header__label">Discovered calendars</div>
                  <strong>
                    {googleCalendars.length
                      ? `${googleCalendars.length} calendars available`
                      : "No calendars discovered yet"}
                  </strong>
                </div>
                <Badge>{selectedCalendarIds.length} selected</Badge>
              </div>

              {googleCalendars.length ? (
                <div className="calendar-list">
                  {googleCalendars.map((calendar) => (
                    <label className="calendar-row" key={calendar.calendarId}>
                      <input
                        checked={selectedCalendarIds.includes(calendar.calendarId)}
                        onChange={() => toggleCalendarSelection(calendar.calendarId)}
                        type="checkbox"
                      />
                      <div className="calendar-row__body">
                        <div className="calendar-row__title">
                          <strong>{calendar.summary}</strong>
                          <div className="calendar-row__badges">
                            {calendar.primary ? <Badge>Primary</Badge> : null}
                            {calendar.timeZone ? <Badge>{calendar.timeZone}</Badge> : null}
                          </div>
                        </div>
                        <div className="calendar-row__meta">{calendar.calendarId}</div>
                        {calendar.description ? (
                          <p className="calendar-row__description">{calendar.description}</p>
                        ) : null}
                      </div>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  Connect Google, then discover calendars to start choosing what stays in sync.
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Local media connector</div>
                <h3>Plex</h3>
              </div>
              <StatusBadge status={plexStatus} />
            </div>

            <p className="panel__summary">
              Plex is configured through your local daemon config. The connector fingerprints each
              library and only restates facts when the library payload changes.
            </p>

            <div className="plex-metrics">
              <MetricTile
                label="Configured libraries"
                value={String(plexStatus?.selectedResourceCount ?? 0)}
              />
              <MetricTile label="Enabled" value={plexStatus?.enabled ? "Yes" : "No"} />
            </div>

            <div className="panel-actions">
              <Button
                disabled={!plexStatus?.enabled || syncingConnector === "plex"}
                onClick={() => void syncNow("plex")}
                tone="accent"
              >
                {syncingConnector === "plex" ? "Syncing..." : "Sync Plex now"}
              </Button>
            </div>

            <div className="status-note">
              <strong>Today</strong>
              <p>
                Plex library and item ingestion is live. Identity is still source-shaped, so this is
                the next place we should tighten entity reuse later.
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function OverviewCard({
  label,
  status,
  summary,
}: {
  label: string;
  status: ConnectorStatus | null;
  summary: string;
}) {
  return (
    <div className="overview-card">
      <div className="overview-card__header">
        <span>{label}</span>
        <StatusDot tone={statusTone(status)} />
      </div>
      <strong>{summary}</strong>
      {status?.lastSyncedAt ? (
        <small>Last sync {formatDateTime(status.lastSyncedAt)}</small>
      ) : status?.lastError ? (
        <small>{status.lastError}</small>
      ) : (
        <small>Waiting for the next sync.</small>
      )}
    </div>
  );
}

function ConnectorStep({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="connector-step">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="connector-step__action">{action}</div>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status: ConnectorStatus | null }) {
  return (
    <div className="status-badge">
      <StatusDot tone={statusTone(status)} />
      <span>{statusLabel(status)}</span>
    </div>
  );
}

function statusTone(status: ConnectorStatus | null): "healthy" | "warn" | "offline" {
  if (!status?.enabled) {
    return "offline";
  }

  if (status.connected) {
    return "healthy";
  }

  return "warn";
}

function statusLabel(status: ConnectorStatus | null) {
  if (!status?.enabled) {
    return "Disabled";
  }

  if (status.connected) {
    return "Connected";
  }

  return "Needs attention";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

async function graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${window.poneglyph.apiBaseUrl}/gql`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as GraphqlResponse<T>;
  if (!response.ok) {
    throw new Error(`Local API request failed with status ${response.status}`);
  }

  if (payload.errors?.length) {
    throw new Error(
      payload.errors
        .map((error) => error.message)
        .filter((message): message is string => Boolean(message))
        .join("; "),
    );
  }

  if (payload.data === undefined) {
    throw new Error("Local API response was missing data");
  }

  return payload.data;
}

async function getConnectorStatuses() {
  const result = await graphqlRequest<{ connectorStatuses: ConnectorStatus[] }>(`
    query ConnectorStatuses {
      connectorStatuses {
        name
        enabled
        connected
        selectedResourceCount
        lastSyncedAt
        lastError
      }
    }
  `);

  return result.connectorStatuses;
}

async function getGoogleCalendars() {
  const result = await graphqlRequest<{ googleCalendars: GoogleCalendarResource[] }>(`
    query GoogleCalendars {
      googleCalendars {
        calendarId
        summary
        description
        timeZone
        primary
        selected
      }
    }
  `);

  return result.googleCalendars;
}

async function discoverGoogleCalendarsMutation() {
  const result = await graphqlRequest<{ discoverGoogleCalendars: GoogleCalendarResource[] }>(`
    mutation DiscoverGoogleCalendars {
      discoverGoogleCalendars {
        calendarId
        summary
        description
        timeZone
        primary
        selected
      }
    }
  `);

  return result.discoverGoogleCalendars;
}

async function selectGoogleCalendarsMutation(calendarIds: string[]) {
  const result = await graphqlRequest<{ selectGoogleCalendars: GoogleCalendarResource[] }>(
    `
      mutation SelectGoogleCalendars($input: SelectGoogleCalendarsInput!) {
        selectGoogleCalendars(input: $input) {
          calendarId
          summary
          description
          timeZone
          primary
          selected
        }
      }
    `,
    {
      input: {
        calendarIds,
      },
    },
  );

  return result.selectGoogleCalendars;
}

async function syncConnectorMutation(name: ConnectorName) {
  const result = await graphqlRequest<{ syncConnector: ConnectorSyncResult }>(
    `
      mutation SyncConnector($name: String!) {
        syncConnector(name: $name) {
          name
          synced
          message
        }
      }
    `,
    { name },
  );

  return result.syncConnector;
}

function ConnectorsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M3.5 5.5h4v4h-4zM8.5 2.5h4v4h-4zM8.5 9.5h4v4h-4z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M7.5 7.5h1M10.5 6.5v3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M2 8h2.2l1.3-2.5L8.2 11l2.2-4h3.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="4" cy="4" fill="none" r="1.7" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="12" cy="5" fill="none" r="1.7" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="8" cy="12" fill="none" r="1.7" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.4 5 7 10.2M10.6 6 9 10.2M5.7 4.4h4.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}
