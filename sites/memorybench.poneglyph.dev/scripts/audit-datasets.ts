import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const MEMORYBENCH_COMMIT = "063b86bfb347336def3a084153f40bfea1e2dfd6";
const expected = {
  locomo: "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
  longmemeval: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
};
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected nonempty string");
  return value;
}
function dataset(path: string, digest: string) {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== digest) throw new Error(`Dataset hash mismatch: ${path}`);
  return { bytes: bytes.length, sha256, records: array(JSON.parse(bytes.toString("utf8"))).map(object) };
}
function audit(benchmark: "locomo" | "longmemeval", path: string) {
  const input = dataset(path, expected[benchmark]);
  const containers: string[] = [];
  const questionTypes: Record<string, number> = {};
  let sessions = 0, messages = 0, textCharacters = 0;
  const questionIds = new Set<string>();
  const categories: Record<string, string> = { "1": "multi-hop", "2": "temporal", "3": "open-domain", "4": "single-hop", "5": "adversarial" };
  for (const row of input.records) {
    const container = string(benchmark === "locomo" ? row.sample_id : row.question_id);
    if (containers.includes(container)) throw new Error(`Duplicate container ${container}`);
    containers.push(container);
    const questions = benchmark === "locomo" ? array(row.qa).map(object) : [row];
    for (const [index, q] of questions.entries()) {
      const type = benchmark === "locomo" ? string(categories[String(q.category)]) : string(q.question_type);
      const id = benchmark === "locomo" ? `${container}-q${index}` : container;
      if (questionIds.has(id)) throw new Error(`Duplicate question ${id}`);
      questionIds.add(id);
      questionTypes[type] = (questionTypes[type] ?? 0) + 1;
    }
    const rawSessions = benchmark === "locomo"
      ? Object.entries(object(row.conversation)).filter(([key, value]) => /^session_\d+$/.test(key) && Array.isArray(value)).map(([, value]) => array(value))
      : array(row.haystack_sessions).map(array);
    sessions += rawSessions.length;
    for (const session of rawSessions) {
      messages += session.length;
      for (const raw of session) {
        const message = object(raw);
        const content = benchmark === "locomo" ? message.text : message.content;
        if (typeof content !== "string") throw new Error(`Invalid message content in ${container}`);
        textCharacters += content.length;
      }
    }
  }
  return { benchmark, sha256: input.sha256, bytes: input.bytes, questions: questionIds.size, sessions, messages, textCharacters, questionTypes, containers: containers.sort() };
}
const [locomo, longmemeval] = process.argv.slice(2);
if (!locomo || !longmemeval) throw new Error("Usage: tsx scripts/audit-datasets.ts LOCOMO_JSON LONGMEMEVAL_S_JSON");
console.log(JSON.stringify({ memorybenchCommit: MEMORYBENCH_COMMIT, datasets: [audit("locomo", locomo), audit("longmemeval", longmemeval)] }, null, 2));
