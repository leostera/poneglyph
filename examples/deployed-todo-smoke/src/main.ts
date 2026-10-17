import { createRequire } from "node:module";

export type Socket = {
  once(event: "open", listener: () => void): Socket;
  once(event: "error", listener: (error: Error) => void): Socket;
  once(event: "message", listener: (data: string | Uint8Array | ArrayBuffer) => void): Socket;
  once(event: "close", listener: () => void): Socket;
  removeListener(event: "message", listener: (data: string | Uint8Array | ArrayBuffer) => void): Socket;
  removeListener(event: "error", listener: (error: Error) => void): Socket;
  removeListener(event: "close", listener: () => void): Socket;
  once(event: "unexpected-response", listener: (_request: unknown, response: { statusCode?: number; resume(): void }) => void): Socket;
  close(): void;
  terminate(): void;
};
type SocketConstructor = new (url: string, options: Readonly<{ headers: Record<string, string>; handshakeTimeout?: number }>) => Socket;
const WebSocketClient = createRequire(import.meta.url)("ws") as SocketConstructor;
export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = environment["PONEGLYPH_CLOUDFLARE_URL"];
  if (!target) throw new TypeError("Set PONEGLYPH_CLOUDFLARE_URL to an explicitly approved TODO validation target");
  const endpoint = new URL(target), baseUrl = endpoint.origin;
  const passphrase = environment["PONEGLYPH_TODO_PASSPHRASE"];
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".poneglyph.leostera.dev") ||
      endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.pathname !== "/") {
    throw new Error("deployed TODO validation requires HTTPS beneath *.poneglyph.leostera.dev");
  }
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error("PONEGLYPH_TODO_PASSPHRASE must come from the local shell environment");
  }

  const page = await fetch(`${baseUrl}/todo`);
  if (!page.ok || !(page.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error(`TODO app page is unavailable (HTTP ${page.status})`);
  }
  const unauthorized = await fetch(`${baseUrl}/api/todo/snapshot`);
  if (unauthorized.status !== 401) throw new Error(`unauthenticated TODO request returned HTTP ${unauthorized.status}, expected 401`);

  const loginResponse = await fetch(`${baseUrl}/api/todo/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }),
  });
  const login: unknown = await loginResponse.json();
  const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!loginResponse.ok || !isRecord(login) || login["authenticated"] !== true || cookie === undefined) {
    throw new Error(`TODO login failed (HTTP ${loginResponse.status}): ${JSON.stringify(login)}`);
  }

  const badPassword = await fetch(`${baseUrl}/api/todo/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: `${passphrase}-wrong` }),
  });
  if (badPassword.status !== 401) throw new Error(`invalid passphrase returned HTTP ${badPassword.status}, expected 401`);

  const snapshot = await getJson(`${baseUrl}/api/todo/snapshot`, cookie);
  if (snapshot["graphId"] !== "todo-shared-2026") throw new Error("TODO snapshot returned an unexpected graph");
  const wsUrl = new URL("/api/todo/ws", endpoint);
  wsUrl.protocol = "wss:";
  const deniedWsStatus = await rejectedSocketStatus(wsUrl.toString(), { Origin: endpoint.origin });
  if (deniedWsStatus !== 401) throw new Error(`unauthenticated WebSocket returned ${deniedWsStatus}, expected 401`);

  const created = await postJson(`${baseUrl}/api/todo/tasks`, {
    title: `deployed smoke ${Date.now()}`,
    list: "todo:list:todo",
  }, cookie);
  const taskId = created["taskId"];
  if (typeof taskId !== "string") throw new Error("task creation did not return taskId");
  const firstClient = await connect(wsUrl.toString(), cookie, endpoint.origin);
  let secondClient: Socket | undefined;
  const pending: Promise<Record<string, unknown>>[] = [];
  try {
    secondClient = await connect(wsUrl.toString(), cookie, endpoint.origin);
    const firstMessage = nextMessage(firstClient);
    const secondMessage = nextMessage(secondClient);
    pending.push(firstMessage, secondMessage);
    // Observe failures immediately while HTTP is in flight; retain the original
    // promises for assertions and drain them even if the move request fails.
    for (const message of pending) void message.catch(() => {});
    const moved = await postJson(`${baseUrl}/api/todo/tasks/${taskId}/move`, { toList: "todo:list:done" }, cookie);
    const txId = moved["txId"];
    if (typeof txId !== "string") throw new Error(`task move did not return a transaction witness: ${JSON.stringify(moved)}`);
    const [eventA, eventB] = await Promise.all([firstMessage, secondMessage]);
    for (const event of [eventA, eventB]) {
      if (event["type"] !== "invalidate" || event["graphId"] !== "todo-shared-2026" || event["txId"] !== txId) {
        throw new Error(`client received an unexpected TODO invalidation: ${JSON.stringify(event)}`);
      }
    }

    const visible = await postJson(`${baseUrl}/v1/graphs/todo-shared-2026/query`, {
      query: `todo:task-list("todo:task:${taskId}", List)`,
    }, cookie);
    const rows = visible["rows"];
    if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0]) ||
        !isRecord(rows[0]["List"]) || rows[0]["List"]["type"] !== "string" || rows[0]["List"]["value"] !== "todo:list:done") {
      throw new Error(`cross-shard move was not fully visible after its successful transaction: ${JSON.stringify(visible)}`);
    }
    console.log(JSON.stringify({
      baseUrl: endpoint.origin,
      appPage: "served",
      unauthenticatedHttp: unauthorized.status,
      invalidPassphrase: badPassword.status,
      unauthenticatedWebSocket: deniedWsStatus,
      graphId: "todo-shared-2026",
      initialSnapshotSeq: snapshot["snapshotSeq"],
      taskId,
      crossShardMove: {txId},
      authenticatedLiveClients: 2,
      invalidationSentAfterVisibleCommit: true,
      querySnapshotSeq: visible["snapshotSeq"],
      queryRows: rows.length,
    }, null, 2));
  } finally {
    firstClient.terminate();
    secondClient?.terminate();
    await Promise.allSettled(pending);
  }
}

async function connect(url: string, cookie: string, origin: string): Promise<Socket> {
  const socket = new WebSocketClient(url, { headers: { Cookie: cookie, Origin: origin }, handshakeTimeout: 10_000 });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function rejectedSocketStatus(url: string, headers: Record<string, string>): Promise<number> {
  const socket = new WebSocketClient(url, { headers });
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for rejected WebSocket handshake")), 10_000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      response.resume();
      socket.terminate();
      resolve(status);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function nextMessage(socket: Socket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("message", received);
      socket.removeListener("error", failed);
      socket.removeListener("close", closed);
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => failed(new Error("TODO WebSocket closed before its invalidation"));
    const received = (data: string | Uint8Array | ArrayBuffer) => {
      cleanup();
      try {
        const text = typeof data === "string" ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
        const message: unknown = JSON.parse(text);
        if (!isRecord(message)) throw new Error("WebSocket message was not an object");
        resolve(message);
      } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => failed(new Error("timed out waiting for a TODO WebSocket invalidation")), 10_000);
    socket.once("message", received);
    socket.once("error", failed);
    socket.once("close", closed);
  });
}

async function getJson(url: string, cookie: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(value)) throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(value)}`);
  return value;
}

async function postJson(url: string, body: unknown, cookie: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(value)) throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(value)}`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
