import { describe, expect, it } from "vitest";
import { BoundedReadCache } from "../src/storage/read-cache.js";

describe("bounded DO read cache", () => {
  it("refreshes recently read entries and evicts the least recently used entry", () => {
    const cache = new BoundedReadCache<string>(2, 1_000);
    cache.set("snapshot:a", "A", 1);
    cache.set("snapshot:b", "B", 1);

    expect(cache.get("snapshot:a")).toBe("A");
    cache.set("snapshot:c", "C", 1);

    expect(cache.get("snapshot:a")).toBe("A");
    expect(cache.get("snapshot:b")).toBeUndefined();
    expect(cache.get("snapshot:c")).toBe("C");
  });

  it("does not retain values larger than its byte budget", () => {
    const cache = new BoundedReadCache<string>(4, 16);
    cache.set("large", "value", 100);

    expect(cache.get("large")).toBeUndefined();
  });

  it("accounts for replacement without retaining the old entry size", () => {
    const cache = new BoundedReadCache<string>(2, 32);
    cache.set("key", "first", 5);
    cache.set("key", "second", 6);
    cache.set("other", "value", 5);

    expect(cache.get("key")).toBe("second");
    expect(cache.get("other")).toBe("value");
  });
});
