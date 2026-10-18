import {createReadStream} from "node:fs";
import {createHash} from "node:crypto";
import {createInterface} from "node:readline";
import {isRecord} from "@leostera/poneglyph/storage-protocol";
import {payload, settings} from "./model.js";

export const corpusSha256 = "e09d65047fe1479eacc7823761526d8280e3071d5c805ddf4b9bef43acb29064";
export async function pageSubsets(path: string, count: number) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  if (digest.digest("hex") !== corpusSha256) throw new Error("Corpus checksum mismatch");
  const scope = settings("00000000-0000-4000-8000-000000000000", "graph", count);
  const pages: ReturnType<typeof payload>["facts"][] = [], entities = new Set<string>();
  let entity: string | undefined, facts: Record<string, unknown>[] = [];
  const flush = () => {
    if (facts.length === 0 || pages.length === count) return;
    if (entity === undefined || entities.has(entity)) throw new Error("Noncontiguous corpus page");
    entities.add(entity);
    const selected: Record<string, unknown>[] = [];
    for (const field of ["wiki:page:title", "wiki:page:category", "wiki:page:link", "wiki:page:namespace", "wiki:page:text_bytes"]) {
      const found = facts.find(fact => fact["field"] === field);
      if (found !== undefined && selected.length < 3) selected.push(found);
    }
    pages.push(payload(scope, {index: pages.length, facts: selected}).facts);
  };
  const input = createInterface({input: createReadStream(path), crlfDelay: Infinity});
  for await (const line of input) {
    const raw: unknown = JSON.parse(line);
    if (!isRecord(raw) || typeof raw["entity"] !== "string") throw new Error("Invalid corpus page");
    if (raw["entity"] !== entity) {
      flush();
      if (pages.length === count) break;
      entity = raw["entity"]; facts = [];
    }
    facts.push(raw);
  }
  flush();
  if (pages.length !== count) throw new Error("Not enough complete corpus pages");
  return pages;
}
