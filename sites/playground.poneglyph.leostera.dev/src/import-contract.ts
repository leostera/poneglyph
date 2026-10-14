import { parseFactBatch, type FactBatch } from "@leostera/poneglyph";

export const IMPORT_ACCESS_AUDIENCE = "81f3a2c62b68cd12e073e0678ec7a786968deed4853e90679528580350b0db3c";
export const IMPORT_BODY_BYTES = 800_000;
export const IMPORT_BATCH_FACTS = 500;
export const IMPORT_RATE_LIMIT = { namespace: "2026101403", simple: { limit: 60, period: 60 as const } };
export type ImportSegment = "pages10" | "remainder90";
export type ImportBatch = Readonly<{ txId: string; sha256: string; facts: number; pages: number; bytes: number }>;
export type ImportPlan = Readonly<{
  version: 1 | 2; segment: ImportSegment; graphId: "onepiece"; service: "poneglyph-service-worker";
  corpusSha256: string; xmlSha256: string; source: string;
  totalPages: number; selectedPages: number; selectedFacts: number;
  openedAt: string; expiresAt: string; batches: readonly ImportBatch[];
}>;

const digest = /^[a-f0-9]{64}$/;
export function parseImportPlan(input: unknown): ImportPlan {
  const plan = input as Partial<ImportPlan> | null;
  const segment = plan?.version === 1 ? "pages10" : plan?.segment;
  if (!plan || (plan.version !== 1 && plan.version !== 2) || (segment !== "pages10" && segment !== "remainder90")
    || plan.graphId !== "onepiece" || plan.service !== "poneglyph-service-worker"
    || typeof plan.corpusSha256 !== "string" || !digest.test(plan.corpusSha256)
    || typeof plan.xmlSha256 !== "string" || !digest.test(plan.xmlSha256)
    || plan.source !== `wiki:onepiece:dump:${plan.xmlSha256}`
    || !Number.isSafeInteger(plan.totalPages) || !Number.isSafeInteger(plan.selectedPages)
    || plan.totalPages! <= 0 || plan.selectedPages! <= 0
    || plan.selectedPages !== (segment === "pages10" ? Math.floor(plan.totalPages! / 10) : plan.totalPages! - Math.floor(plan.totalPages! / 10))
    || !Number.isSafeInteger(plan.selectedFacts) || plan.selectedFacts! <= 0
    || typeof plan.openedAt !== "string" || typeof plan.expiresAt !== "string"
    || !Number.isFinite(Date.parse(plan.openedAt)) || !Number.isFinite(Date.parse(plan.expiresAt))
    || Date.parse(plan.expiresAt) <= Date.parse(plan.openedAt)
    || Date.parse(plan.expiresAt) - Date.parse(plan.openedAt) > 2 * 86_400_000
    || !Array.isArray(plan.batches) || plan.batches.length === 0) throw new Error("Invalid approved import plan");
  let pages = 0, facts = 0;
  const batches = plan.batches.map((batch, index) => {
    if (!batch || batch.txId !== `wiki:import:${plan.corpusSha256}:${segment}:${index}`
      || typeof batch.sha256 !== "string" || !digest.test(batch.sha256)
      || !Number.isSafeInteger(batch.facts) || batch.facts <= 0 || batch.facts > IMPORT_BATCH_FACTS
      || !Number.isSafeInteger(batch.pages) || batch.pages <= 0 || batch.pages > batch.facts
      || !Number.isSafeInteger(batch.bytes) || batch.bytes <= 0 || batch.bytes > IMPORT_BODY_BYTES) throw new Error("Invalid approved import batch");
    pages += batch.pages; facts += batch.facts;
    return Object.freeze({ txId: batch.txId, sha256: batch.sha256, facts: batch.facts, pages: batch.pages, bytes: batch.bytes });
  });
  if (pages !== plan.selectedPages || facts !== plan.selectedFacts) throw new Error("Import plan totals disagree");
  return Object.freeze({ version: plan.version, segment, graphId: "onepiece", service: "poneglyph-service-worker", corpusSha256: plan.corpusSha256,
    xmlSha256: plan.xmlSha256, source: plan.source, totalPages: plan.totalPages!, selectedPages: pages, selectedFacts: facts,
    openedAt: plan.openedAt, expiresAt: plan.expiresAt, batches: Object.freeze(batches) });
}

export async function parseApprovedBatch(bytes: Uint8Array, plan: ImportPlan): Promise<{ ordinal: number; batch: FactBatch }> {
  if (bytes.byteLength > IMPORT_BODY_BYTES) throw new Error("Import body exceeds byte limit");
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof input !== "object" || input === null || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "batch,facts,txId" || !("batch" in input)
    || typeof input.batch !== "number" || !Number.isSafeInteger(input.batch) || input.batch < 0) throw new Error("Expected an approved batch ordinal");
  const approved = plan.batches[input.batch];
  if (!approved || bytes.byteLength !== approved.bytes) throw new Error("Batch is not in the approved plan");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== approved.sha256) throw new Error("Batch payload does not match approved SHA-256");
  const batch = parseFactBatch(input);
  if (!batch.ok || batch.value.txId !== approved.txId || batch.value.facts.length !== approved.facts
    || batch.value.facts.some(fact => fact.source !== plan.source || fact.retraction)) throw new Error("Invalid approved fact batch");
  return { ordinal: input.batch, batch: batch.value };
}
