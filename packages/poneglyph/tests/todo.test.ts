import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {transactionCoordinatorName} from "../src/storage/forest.js";
import { TODO_GRAPH_ID, TODO_LISTS } from "../src/todo_demo/service.js";

const origin = "https://poneglyph.test";
const passphrase = "test-only-shared-passphrase";

describe("authenticated reactive TODO demo", () => {
  it("commits a cross-shard task move before invalidating both authenticated clients", async () => {
    const denied = await request("/api/todo/snapshot");
    expect(denied.status).toBe(401);
    const exposedGraph = await request(`/v1/graphs/${TODO_GRAPH_ID}/query`, {
      method: "POST", body: JSON.stringify({ query: "schema:name(Entity, Name)" }),
    });
    expect(exposedGraph.status).toBe(401);

    const badLogin = await request("/api/todo/login", {
      method: "POST", headers: { origin }, body: JSON.stringify({ passphrase: "incorrect" }),
    });
    expect(badLogin.status).toBe(401);

    const login = await request("/api/todo/login", {
      method: "POST", headers: { origin }, body: JSON.stringify({ passphrase }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^poneglyph_todo=/);
    if (cookie === undefined) throw new Error("login response did not set the session cookie");

    const csrf = await request("/api/todo/tasks", {
      method: "POST", headers: { cookie, origin: "https://attacker.example" },
      body: JSON.stringify({ title: "forbidden", list: TODO_LISTS.todo }),
    });
    expect(csrf.status).toBe(403);

    const authenticatedGraphQuery = await request(`/v1/graphs/${TODO_GRAPH_ID}/query`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({ query: "schema:name(Entity, Name)" }),
    });
    expect(authenticatedGraphQuery.status).toBe(200);
    const bypassWrite = await request(`/v1/graphs/${TODO_GRAPH_ID}/transactions`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({
        facts: [{ source: "agent:test", entity: "todo:task:external", field: "schema:name", value: { type: "text", value: "bypass" }, retraction: false }],
      }),
    });
    expect(bypassWrite.status).toBe(403);
    const snapshot = await request("/api/todo/snapshot", { headers: { cookie } });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ graphId: TODO_GRAPH_ID, snapshotSeq: 0, tasks: [] });

    const deniedSocket = await request("/api/todo/ws", { headers: { upgrade: "websocket", origin } });
    expect(deniedSocket.status).toBe(401);
    const crossOriginSocket = await request("/api/todo/ws", {
      headers: { upgrade: "websocket", origin: "https://attacker.example", cookie },
    });
    expect(crossOriginSocket.status).toBe(403);

    const created = await request("/api/todo/tasks", {
      method: "POST", headers: { cookie, origin },
      body: JSON.stringify({ title: "Review the storage invariants", list: TODO_LISTS.todo }),
    });
    expect(created.status).toBe(200);
    const task: unknown = await created.json();
    if (!isRecord(task) || typeof task["taskId"] !== "string") throw new Error("task creation response is invalid");
    const taskId = task["taskId"];

    const firstClient = await connect(cookie);
    const secondClient = await connect(cookie);
    const firstEvent = nextMessage(firstClient);
    const secondEvent = nextMessage(secondClient);
    const moved = await request(`/api/todo/tasks/${taskId}/move`, {
      method: "POST", headers: { cookie, origin }, body: JSON.stringify({ toList: TODO_LISTS.done }),
    });
    expect(moved.status).toBe(200);
    const moveResult: unknown = await moved.json();
    if (!isRecord(moveResult) || typeof moveResult["txId"] !== "string") {
      throw new Error("move response is invalid");
    }

    const [eventA, eventB] = await Promise.all([firstEvent, secondEvent]);
    expect(eventA).toMatchObject({type: "invalidate", graphId: TODO_GRAPH_ID, txId: moveResult["txId"]});
    expect(eventB).toEqual(eventA);
    const visible = await request("/api/todo/snapshot", { headers: { cookie } });
    expect(visible.status).toBe(200);
    const visibleBody: unknown = await visible.json();
    expect(visibleBody).toMatchObject({snapshotSeq: expect.any(Number), tasks: [{id: taskId, title: "Review the storage invariants", list: TODO_LISTS.done}]});

    const metadata = await runInDurableObject(env.GRAPH_LEDGERS.getByName(await transactionCoordinatorName(TODO_GRAPH_ID, moveResult["txId"])), (_instance, state) =>
      state.storage.sql.exec<{plan_json: string}>("SELECT plan_json FROM candidate_transactions WHERE tx_id = ?", moveResult["txId"]).one().plan_json);
    const plan: unknown = JSON.parse(metadata);
    if (!isRecord(plan) || !Array.isArray(plan["participants"])) throw new Error("missing committed participant plan");
    expect(plan["participants"].length).toBeGreaterThanOrEqual(2);
    expect(plan["participants"].length).toBeLessThanOrEqual(3);
    firstClient.close();
    secondClient.close();
  });
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const requestInit: RequestInit = { ...init, headers };
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`${origin}${path}`, requestInit));
}

async function connect(cookie: string): Promise<WebSocket> {
  const response = await request("/api/todo/ws", {
    headers: { upgrade: "websocket", origin, cookie },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("WebSocket handshake did not return a client socket");
  socket.accept();
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for TODO invalidation")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!isRecord(parsed)) throw new Error("expected an invalidation object");
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
