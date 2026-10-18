const encoder = new TextEncoder();

type CacheEntry<Value> = Readonly<{value: Value; bytes: number}>;

/**
 * A DO-instance-local LRU. Eviction affects performance only; callers must key
 * entries by every value that can change the cached read result.
 */
export class BoundedReadCache<Value> {
  private readonly entries = new Map<string, CacheEntry<Value>>();
  private retainedBytes = 0;
  private hitCount = 0;

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("read-cache bounds must be positive safe integers");
    }
  }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.hitCount += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  get hits(): number {
    return this.hitCount;
  }

  set(key: string, value: Value, valueBytes: number): void {
    if (!Number.isSafeInteger(valueBytes) || valueBytes < 0) return;
    const entryBytes = encoder.encode(key).byteLength + valueBytes;
    if (entryBytes > this.maxBytes) return;

    this.delete(key);
    while (this.entries.size >= this.maxEntries || this.retainedBytes + entryBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.delete(oldestKey);
    }

    this.entries.set(key, {value, bytes: entryBytes});
    this.retainedBytes += entryBytes;
  }

  private delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    this.retainedBytes -= existing.bytes;
  }
}

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}
