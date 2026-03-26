import http from "node:http";
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";
import { findLatestBuild, parseElectronApp } from "electron-playwright-helpers";

type MockServer = {
  close: () => Promise<void>;
  url: string;
};

type PlexConnection = {
  __typename: "PlexConnection";
  id: number;
  name: string;
  baseUrl: string;
  libraries: string[];
  lastSyncedAt: string | null;
  lastError: string | null;
};

async function startMockPoneglyphApi(): Promise<MockServer> {
  let nextPlexConnectionId = 2;
  let plexConnections: PlexConnection[] = [
    {
      __typename: "PlexConnection",
      id: 1,
      name: "Home Plex",
      baseUrl: "http://127.0.0.1:32400",
      libraries: ["Movies"],
      lastSyncedAt: "2026-03-25T10:00:00Z",
      lastError: null,
    },
  ];

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request
      .on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      })
      .on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const query = String(body.query ?? "");
        const variables = body.variables ?? {};

        response.setHeader("content-type", "application/json");

        if (request.url === "/gql" && request.method === "POST") {
          if (query.includes("connectorStatuses")) {
            response.end(
              JSON.stringify({
                data: {
                  connectorStatuses: [
                    {
                      __typename: "ConnectorStatus",
                      name: "gcal",
                      enabled: true,
                      connected: false,
                      selectedResourceCount: 0,
                      lastSyncedAt: null,
                      lastError: null,
                    },
                    {
                      __typename: "ConnectorStatus",
                      name: "plex",
                      enabled: true,
                      connected: plexConnections.length > 0,
                      selectedResourceCount: plexConnections.reduce(
                        (count, connection) => count + connection.libraries.length,
                        0,
                      ),
                      lastSyncedAt: null,
                      lastError: null,
                    },
                  ],
                },
              }),
            );
            return;
          }

          if (query.includes("plexConnections")) {
            response.end(
              JSON.stringify({
                data: {
                  plexConnections,
                },
              }),
            );
            return;
          }

          if (query.includes("detectLocalPlexConnection")) {
            response.end(
              JSON.stringify({
                data: {
                  detectLocalPlexConnection: {
                    __typename: "PlexDetection",
                    baseUrl: "http://127.0.0.1:32400",
                    token: "detected-token",
                    machineIdentifier: "machine-1",
                    libraries: [
                      { __typename: "PlexLibraryOption", id: "1", name: "Movies" },
                      { __typename: "PlexLibraryOption", id: "2", name: "Shows" },
                      { __typename: "PlexLibraryOption", id: "3", name: "Anime" },
                    ],
                  },
                },
              }),
            );
            return;
          }

          if (query.includes("discoverPlexLibraries")) {
            response.end(
              JSON.stringify({
                data: {
                  discoverPlexLibraries: [
                    { __typename: "PlexLibraryOption", id: "1", name: "Movies" },
                    { __typename: "PlexLibraryOption", id: "2", name: "Shows" },
                    { __typename: "PlexLibraryOption", id: "3", name: "Anime" },
                  ],
                },
              }),
            );
            return;
          }

          if (query.includes("savePlexConnection")) {
            const input = variables.input as {
              name: string;
              baseUrl: string;
              token: string;
              libraries: string[];
            };

            const existing = plexConnections.find(
              (connection) => connection.baseUrl === input.baseUrl,
            );
            if (existing) {
              existing.name = input.name;
              existing.libraries = input.libraries;
              response.end(
                JSON.stringify({
                  data: {
                    savePlexConnection: existing,
                  },
                }),
              );
              return;
            }

            const created: PlexConnection = {
              __typename: "PlexConnection",
              id: nextPlexConnectionId++,
              name: input.name,
              baseUrl: input.baseUrl,
              libraries: input.libraries,
              lastSyncedAt: null,
              lastError: null,
            };
            plexConnections = [created, ...plexConnections];
            response.end(
              JSON.stringify({
                data: {
                  savePlexConnection: created,
                },
              }),
            );
            return;
          }

          if (query.includes("deletePlexConnection")) {
            const connectionId = Number(variables.connectionId);
            const before = plexConnections.length;
            plexConnections = plexConnections.filter(
              (connection) => connection.id !== connectionId,
            );
            response.end(
              JSON.stringify({
                data: {
                  deletePlexConnection: plexConnections.length < before,
                },
              }),
            );
            return;
          }

          if (query.includes("syncConnector")) {
            response.end(
              JSON.stringify({
                data: {
                  syncConnector: {
                    __typename: "ConnectorSyncResult",
                    name: "plex",
                    synced: true,
                    message: "ok",
                  },
                },
              }),
            );
            return;
          }
        }

        response.statusCode = 404;
        response.end(JSON.stringify({ errors: [{ message: "Not found" }] }));
      });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock API did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

let electronApp: ElectronApplication;
let page: Page;
let mockApi: MockServer;

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  mockApi = await startMockPoneglyphApi();
  const latestBuild = findLatestBuild();
  const appInfo = parseElectronApp(latestBuild);

  electronApp = await electron.launch({
    args: [appInfo.main],
    env: {
      ...process.env,
      CI: "e2e",
      PONEGLYPH_E2E: "true",
      PONEGLYPH_API_URL: mockApi.url,
      PONEGLYPH_OPEN_DEVTOOLS: "false",
    },
  });

  page = await electronApp.firstWindow();
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  if (mockApi) {
    await mockApi.close();
  }
});

test("manages multiple plex instances from provider detail page", async () => {
  await page.waitForURL(/#\/connectors$/);

  await page.getByText("Plex").first().click();
  await expect(page).toHaveURL(/#\/connectors\/plex$/);
  await expect(page.getByRole("heading", { name: "Plex" })).toBeVisible();

  await page.getByRole("button", { name: "Detect" }).click();
  await expect(page.getByPlaceholder("Base URL (e.g. http://127.0.0.1:32400)")).toHaveValue(
    "http://127.0.0.1:32400",
  );
  await expect(page.getByPlaceholder("Plex token")).toHaveValue("detected-token");

  await page.getByRole("button", { name: "Discover libraries" }).click();
  await expect(page.getByText("Movies ×")).toBeVisible();
  await expect(page.getByText("Shows ×")).toBeVisible();

  await page.getByPlaceholder("Name (required)").fill("Remote Plex");
  await page
    .getByPlaceholder("Base URL (e.g. http://127.0.0.1:32400)")
    .fill("http://127.0.0.2:32400");
  await page.getByPlaceholder("Plex token").fill("manual-token");
  await page.getByRole("button", { name: "Save server" }).click();

  await expect(page.getByText("Remote Plex")).toBeVisible();
  await expect(page.getByText("Home Plex")).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete connection" }).click();

  await expect(page.getByText("Remote Plex")).not.toBeVisible();
  await expect(page.getByText("Home Plex")).toBeVisible();
});
