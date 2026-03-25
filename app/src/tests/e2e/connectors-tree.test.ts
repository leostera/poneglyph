import http from "node:http";
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from "@playwright/test";
import { findLatestBuild, parseElectronApp } from "electron-playwright-helpers";

const connectorStatuses = [
  {
    __typename: "ConnectorStatus",
    name: "gcal",
    enabled: true,
    connected: true,
    selectedResourceCount: 2,
    lastSyncedAt: "2026-03-25T09:30:00Z",
    lastError: null,
  },
  {
    __typename: "ConnectorStatus",
    name: "plex",
    enabled: true,
    connected: true,
    selectedResourceCount: 3,
    lastSyncedAt: "2026-03-25T08:00:00Z",
    lastError: null,
  },
] as const;

const googleCalendars = [
  {
    __typename: "GoogleCalendarResource",
    calendarId: "primary",
    summary: "Primary",
    description: "Main calendar",
    timeZone: "Europe/Prague",
    primary: true,
    selected: true,
  },
  {
    __typename: "GoogleCalendarResource",
    calendarId: "family",
    summary: "Family",
    description: "Shared plans",
    timeZone: "Europe/Prague",
    primary: false,
    selected: true,
  },
] as const;

type MockServer = {
  close: () => Promise<void>;
  url: string;
};

async function startMockPoneglyphApi(): Promise<MockServer> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request
      .on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      })
      .on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const query = String(body.query ?? "");

        response.setHeader("content-type", "application/json");

        if (request.url === "/gql" && request.method === "POST") {
          if (query.includes("connectorStatuses")) {
            response.end(
              JSON.stringify({
                data: {
                  connectorStatuses,
                },
              }),
            );
            return;
          }

          if (query.includes("googleCalendars")) {
            response.end(
              JSON.stringify({
                data: {
                  googleCalendars,
                },
              }),
            );
            return;
          }

          if (query.includes("discoverGoogleCalendars")) {
            response.end(
              JSON.stringify({
                data: {
                  discoverGoogleCalendars: googleCalendars,
                },
              }),
            );
            return;
          }

          if (query.includes("selectGoogleCalendars")) {
            response.end(
              JSON.stringify({
                data: {
                  selectGoogleCalendars: googleCalendars,
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
                    name: "gcal",
                    enqueued: true,
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
  await electronApp.close();
  await mockApi.close();
});

test("navigates the connectors screen tree", async () => {
  await page.waitForURL(/#\/connectors$/);
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
  await expect(page.getByText("Google Calendar")).toBeVisible();
  await expect(page.getByText("Plex")).toBeVisible();

  await page.getByRole("link", { name: "Add connector" }).first().click();
  await expect(page).toHaveURL(/#\/connectors\/add$/);
  await expect(page.getByRole("heading", { name: "Add connector" })).toBeVisible();

  await page.getByRole("link", { name: /Google Calendar/i }).click();
  await expect(page).toHaveURL(/#\/connectors\/google\/onboard\/connect$/);
  await expect(page.getByRole("heading", { name: "Connect Google Calendar" })).toBeVisible();

  await page.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/#\/connectors\/google\/onboard\/select$/);
  await expect(page.getByText("Step 2. Choose calendars")).toBeVisible();
  await expect(page.getByText("Primary")).toBeVisible();
  await expect(page.getByText("Family")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/#\/connectors\/gcal$/);
  await expect(page.getByRole("heading", { name: "Google Calendar" })).toBeVisible();
  await expect(page.getByText("Calendar selection")).toBeVisible();
  await expect(page.getByText("Primary")).toBeVisible();
  await expect(page.getByText("Family")).toBeVisible();

  await page.getByRole("link", { name: "Logs" }).click();
  await expect(page).toHaveURL(/#\/connectors\/gcal\/logs$/);
  await expect(page.getByText("Runtime event stream is still minimal")).toBeVisible();
  await expect(page.getByText("Selected")).toBeVisible();
});
