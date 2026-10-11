import { randomUUID } from "node:crypto";
const DEFAULT_BASE_URL = "https://poneglyph-scaleout-20261011.poneglyph.leostera.dev";
const baseUrl = (process.env["PONEGLYPH_CLOUDFLARE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

async function main(): Promise<void> {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".poneglyph.leostera.dev")) {
    throw new Error("deployed validation must use an HTTPS host under *.poneglyph.leostera.dev");
  }

  const graphId = `cf-scaleout-${randomUUID()}`;
  const txId = `poneglyph:tx:${randomUUID()}`;
  const entities = Array.from({ length: 4 }, (_, index) => `wiki:person:cf-scaleout-${index}`);
  const facts = entities.map((entity, index) => ({
    source: "agent:cf-scaleout-validation",
    entity,
    field: "schema:name",
    value: { type: "text", value: `Poneglyph scale-out test ${index}` },
    retraction: false,
  }));
  const transaction = { txId, facts };

  const committed = await postJson(`${baseUrl}/v1/graphs/${graphId}/transactions`, transaction);
  if (committed["status"] !== "committed" || committed["commitSeq"] !== 1 || committed["txId"] !== txId) {
    throw new Error(`unexpected transaction outcome: ${JSON.stringify(committed)}`);
  }

  const replayed = await postJson(`${baseUrl}/v1/graphs/${graphId}/transactions`, transaction);
  if (replayed["status"] !== "committed" || replayed["commitSeq"] !== committed["commitSeq"]) {
    throw new Error(`same-txId retry did not return the committed outcome: ${JSON.stringify(replayed)}`);
  }

  const query = await postJson(`${baseUrl}/v1/graphs/${graphId}/query`, {
    query: 'schema:name(Entity, Name), startsWith(Name, "Poneglyph scale-out test")',
  });
  const rows = query["rows"];
  const snapshotSeq = query["snapshotSeq"];
  if (!Array.isArray(rows) || rows.length !== entities.length || !rows.every(isRecord)) {
    throw new Error(`distributed query did not return every committed entity: ${JSON.stringify(query)}`);
  }
  if (snapshotSeq !== committed["commitSeq"]) {
    throw new Error(`query snapshot ${String(snapshotSeq)} did not match commit ${String(committed["commitSeq"])}`);
  }

  const metrics = isRecord(query["metrics"]) ? query["metrics"] : {};
  if (metrics["shardRequests"] !== 1) {
    throw new Error(`unsplit graph should query exactly one root leaf: ${JSON.stringify(metrics)}`);
  }

  console.log(JSON.stringify({
    baseUrl: endpoint.origin,
    graphId,
    txId,
    factsWritten: facts.length,
    initialDirectoryLeaves: 1,
    commitSeq: committed["commitSeq"],
    replayStatus: replayed["status"],
    snapshotSeq,
    rows: rows.length,
    metrics,
  }, null, 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchWithRetry(url: string, body: string): Promise<Response> {
  const attempts = 20;
  const retryableStatuses = new Set([502, 503, 520, 521, 522, 523, 524, 525, 526, 530]);
  let lastFailure: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!retryableStatuses.has(response.status) || attempt === attempts - 1) return response;
      lastFailure = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastFailure = error;
    }

    if (attempt < attempts - 1) {
      const delayMs = Math.min(1_000 + attempt * 500, 10_000);
      console.warn(`Cloudflare validation endpoint not ready (attempt ${attempt + 1}/${attempts}); retrying in ${delayMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const message = lastFailure instanceof Error && lastFailure.cause instanceof Error
    ? `${lastFailure.message}: ${lastFailure.cause.message}`
    : lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
  throw new Error(`request to ${url} failed after ${attempts} attempts: ${message}`);
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(url, JSON.stringify(body));
  const result: unknown = await response.json().catch(() => undefined);
  if (!isRecord(result)) throw new Error(`expected a JSON object from ${url} (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(result)}`);
  return result;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
