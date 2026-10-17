import { isRecord } from "../domain/result.js";
import { coordinatorObjectName } from "../storage/keys.js";
import { jsonResponse, readJsonBody } from "../storage/http.js";
import type { TodoInvalidation } from "./hub.js";

export const TODO_GRAPH_ID = "todo-shared-2026";
export const TODO_LISTS = Object.freeze({
  todo: "todo:list:todo",
  done: "todo:list:done",
});

const TODO_SOURCE = "agent:shared-todo-demo";

export async function handleTodoApi(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/todo/snapshot" && request.method === "GET") return await readSnapshot(env);
  if (path === "/api/todo/tasks" && request.method === "POST") return await createTask(request, env);
  const move = /^\/api\/todo\/tasks\/([0-9a-f-]{36})\/move$/.exec(path);
  if (move !== null && request.method === "POST") return await moveTask(request, env, move[1] ?? "");
  return jsonResponse({ error: "not found" }, 404);
}

async function readSnapshot(env: Env): Promise<Response> {
  const query = await runQuery(env, "todo:task-list(Task, List), schema:name(Task, Title)");
  if (!query.ok) return query.response;
  const tasks: Readonly<{ id: string; title: string; list: string }>[] = [];
  for (const row of query.rows) {
    const task = bindingString(row["Task"]);
    const title = bindingString(row["Title"]);
    const list = bindingString(row["List"]);
    if (task === undefined || title === undefined || list === undefined) continue;
    tasks.push({ id: task.slice("todo:task:".length), title, list });
  }
  return jsonResponse({
    graphId: TODO_GRAPH_ID,
    snapshotSeq: query.snapshotSeq,
    tasks,
    lists: [
      { id: TODO_LISTS.todo, label: "To do" },
      { id: TODO_LISTS.done, label: "Done" },
    ],
    metrics: query.metrics,
  });
}

async function createTask(request: Request, env: Env): Promise<Response> {
  const input = await readJsonBody(request, 4_096);
  if (!input.ok || !isRecord(input.value)) return jsonResponse({ error: "expected a task object" }, 400);
  const title = input.value["title"];
  const list = input.value["list"];
  if (typeof title !== "string" || title.trim().length === 0 || title.trim().length > 200 || !isTodoList(list)) {
    return jsonResponse({ error: "title (1–200 characters) and a supported list are required" }, 400);
  }
  const taskId = crypto.randomUUID();
  const task = `todo:task:${taskId}`;
  const transaction = await commitFacts(env, [
    fact(task, "schema:name", { type: "text", value: title.trim() }),
    fact(task, "todo:task-list", { type: "reference", value: list }),
    fact(list, "todo:contains", { type: "reference", value: task }),
  ]);
  if (!transaction.ok) return transaction.response;
  await publishInvalidation(env, transaction, [list]);
  return jsonResponse({ taskId, title: title.trim(), list, ...transaction });
}

async function moveTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const input = await readJsonBody(request, 4_096);
  if (!input.ok || !isRecord(input.value) || !isTodoList(input.value["toList"])) {
    return jsonResponse({ error: "expected a supported toList" }, 400);
  }
  const toList = input.value["toList"];
  const task = `todo:task:${taskId}`;
  const current = await runQuery(env, `todo:task-list("${task}", List)`);
  if (!current.ok) return current.response;
  const rows = current.rows.filter((row) => bindingString(row["List"]) !== undefined);
  if (rows.length !== 1) return jsonResponse({ error: "task not found or has an invalid list projection" }, 404);
  const fromList = bindingString(rows[0]?.["List"]);
  if (!isTodoList(fromList)) return jsonResponse({ error: "task list is outside the shared demo" }, 409);
  if (fromList === toList) return jsonResponse({ error: "task is already in that list" }, 409);

  const transaction = await commitFacts(env, [
    fact(task, "todo:task-list", { type: "reference", value: fromList }, true),
    fact(task, "todo:task-list", { type: "reference", value: toList }),
    fact(fromList, "todo:contains", { type: "reference", value: task }, true),
    fact(toList, "todo:contains", { type: "reference", value: task }),
  ]);
  if (!transaction.ok) return transaction.response;
  await publishInvalidation(env, transaction, [fromList, toList]);
  return jsonResponse({ taskId, fromList, toList, ...transaction });
}

async function commitFacts(env: Env, facts: readonly unknown[]): Promise<
  | Readonly<{ok: true; txId: string}>
  | Readonly<{ok: false; response: Response}>
> {
  const response = await env.GRAPH_FACADES.getByName(coordinatorObjectName(TODO_GRAPH_ID)).fetch(
    `https://coordinator.internal/v1/graphs/${TODO_GRAPH_ID}/transactions`,
    {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({facts}),
    },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body) || typeof body["txId"] !== "string") {
    return {ok: false, response: jsonResponse(isRecord(body) ? body : {error: "transaction failed"}, response.status || 502)};
  }
  return {ok: true, txId: body["txId"]};
}

async function runQuery(env: Env, query: string): Promise<
  | Readonly<{ ok: true; rows: readonly Record<string, unknown>[]; snapshotSeq: number; metrics: unknown }>
  | Readonly<{ ok: false; response: Response }>
> {
  const response = await env.GRAPH_FACADES.getByName(coordinatorObjectName(TODO_GRAPH_ID)).fetch(
    `https://coordinator.internal/v1/graphs/${TODO_GRAPH_ID}/query`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body) || !Array.isArray(body["rows"]) || typeof body["snapshotSeq"] !== "number") {
    return { ok: false, response: jsonResponse(isRecord(body) ? body : { error: "query failed" }, response.status || 502) };
  }
  const rows = body["rows"].filter(isRecord);
  return { ok: true, rows, snapshotSeq: body["snapshotSeq"], metrics: body["metrics"] };
}

async function publishInvalidation(
  env: Env,
  transaction: Readonly<{txId: string}>,
  changedLists: readonly string[],
): Promise<void> {
  const hub = env.TODO_HUBS.getByName("shared-todo");
  const message: TodoInvalidation = {
    type: "invalidate",
    graphId: TODO_GRAPH_ID,
    txId: transaction.txId,
    changedLists,
  };
  try {
    const response = await hub.fetch("https://todo-hub.internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) console.error("TODO invalidation was not delivered", { txId: transaction.txId, status: response.status });
  } catch (error) {
    console.error("TODO invalidation was not delivered", { txId: transaction.txId, error: String(error) });
  }
}

function fact(entity: string, field: string, value: Readonly<{ type: "text" | "reference"; value: string }>, retraction = false) {
  return { source: TODO_SOURCE, entity, field, value, retraction };
}

function isTodoList(input: unknown): input is string {
  return input === TODO_LISTS.todo || input === TODO_LISTS.done;
}

function bindingString(input: unknown): string | undefined {
  return isRecord(input) && input["type"] === "string" && typeof input["value"] === "string"
    ? input["value"]
    : undefined;
}
