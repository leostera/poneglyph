import type { FactBatch } from "../domain/fact.js";

const MAX_ENTRIES = 8;
const MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;
type Entry = Readonly<{json: string; batch: FactBatch; bytes: number}>;

// Actor-wide serialized-size/entry bounds, not a physical-heap accounting claim.
// Exact durable JSON equality is required; losing this cache changes no decision.
export class BatchCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  get(id: string, json: string): FactBatch | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.json !== json) return undefined;
    this.entries.delete(id); this.entries.set(id, entry);
    return entry.batch;
  }

  put(id: string, json: string, batch: FactBatch): void {
    this.delete(id);
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > MAX_SERIALIZED_BYTES) return;
    while (this.entries.size >= MAX_ENTRIES || this.bytes + bytes > MAX_SERIALIZED_BYTES)
      this.delete(this.entries.keys().next().value!);
    this.entries.set(id, {json, batch, bytes}); this.bytes += bytes;
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {this.bytes -= entry.bytes; this.entries.delete(id);}
  }
}
