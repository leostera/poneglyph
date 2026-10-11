import { randomUUID } from "node:crypto";
import { SHARD_COUNT } from "../poneglyph/src/storage/constants.ts";

const DEFAULT_BASE_URL = "https://poneglyph-checkpoint-20261011.poneglyph.leostera.dev";
const baseUrl = (process.env["PONEGLYPH_CLOUDFLARE_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

async function main(): Promise<void> {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".poneglyph.leostera.dev")) {
    throw new Error("deployed validation must use an HTTPS host under *.poneglyph.leostera.dev");
  }

  const graphId = `cf-checkpoint-${randomUUID()}`;
  const txId = `poneglyph:tx:${randomUUID()}`;
  const entities = oneEntityPerLeaf();
  const facts = entities.map((entity, index) => ({
    source: "agent:cf-checkpoint-validation",
    entity,
    field: "schema:name",
    value: { type: "text", value: `Poneglyph checkpoint test ${index}` },
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
    query: 'schema:name(Entity, Name), startsWith(Name, "Poneglyph checkpoint test")',
  });
  const rows = query["rows"];
  const snapshotSeq = query["snapshotSeq"];
  if (!Array.isArray(rows) || rows.length !== SHARD_COUNT || !rows.every(isRecord)) {
    throw new Error(`distributed query did not return one row per leaf: ${JSON.stringify(query)}`);
  }
  if (snapshotSeq !== committed["commitSeq"]) {
    throw new Error(`query snapshot ${String(snapshotSeq)} did not match commit ${String(committed["commitSeq"])}`);
  }

  const metrics = isRecord(query["metrics"]) ? query["metrics"] : {};
  if (metrics["shardRequests"] !== undefined &&
      (typeof metrics["shardRequests"] !== "number" || metrics["shardRequests"] < SHARD_COUNT)) {
    throw new Error(`query metrics do not show four-leaf fan-out: ${JSON.stringify(metrics)}`);
  }

  console.log(JSON.stringify({
    baseUrl: endpoint.origin,
    graphId,
    txId,
    factsWritten: facts.length,
    shardIndices: entities.map((entity) => shardIndexForEntity(entity)),
    commitSeq: committed["commitSeq"],
    replayStatus: replayed["status"],
    snapshotSeq,
    rows: rows.length,
    metrics,
  }, null, 2));
}

function oneEntityPerLeaf(): string[] {
  const entities: (string | undefined)[] = Array.from({ length: SHARD_COUNT }, () => undefined);
  for (let candidate = 0; candidate < 10_000 && entities.some((entity) => entity === undefined); candidate += 1) {
    const entity = `wiki:person:cf-checkpoint-${candidate}`;
    const shard = shardIndexForEntity(entity);
    if (entities[shard] === undefined) entities[shard] = entity;
  }

  if (entities.some((entity) => entity === undefined)) {
    throw new Error("could not find an entity for each fixed hash leaf");
  }
  return entities as string[];
}

// Keep this fixed-topology hash aligned with src/storage/keys.ts.
function shardIndexForEntity(entity: string): number {
  let hash = 14_695_981_039_346_656_037n;
  for (const byte of new TextEncoder().encode(entity)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1_099_511_628_211n);
  }
  return Number(hash % BigInt(SHARD_COUNT));
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
