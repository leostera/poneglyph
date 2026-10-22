import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest } from "./facts.js";

export class Store {
  constructor(readonly root: string) {}
  path(key: string): string { return join(this.root, `${digest(key)}.json`); }
  async get(key: string): Promise<unknown | undefined> {
    try { return JSON.parse(await readFile(this.path(key), "utf8")); }
    catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  }
  async put(key: string, value: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.path(key), temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    const directory = await open(dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async event(event: Readonly<Record<string, unknown>>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const file = await open(join(this.root, "events.ndjson"), "a", 0o600);
    try { await file.writeFile(JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); await file.sync(); } finally { await file.close(); }
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected record");
  return value as Record<string, unknown>;
}
