import { describe, expect, it } from "vitest";
import { acquireParallelReadCut, queryReadPrefixes } from "../src/storage/read-cut.js";
import { parseDatalogQuery } from "../src/datalog/parser.js";
import { parseGraphId } from "../src/domain/graph-id.js";
import { treeForKey } from "../src/storage/forest.js";
import { virtualKeyForEntity } from "../src/storage/keys.js";
import { TREE_PREFIXES, type TreeSnapshot } from "../src/storage/forest.js";

const lease = (prefix: TreeSnapshot["prefix"]): TreeSnapshot => ({prefix, readId: `read-${prefix}`, snapshotSeq: 1, directoryEpoch: 0, expiresAtMs: Date.now() + 30_000});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

describe("pointed read owner selection", () => {
  const graph = parseGraphId("read-cut-test");
  if (!graph.ok) throw new Error("invalid fixture graph");
  const select = async (source: string) => {
    const parsed = parseDatalogQuery(source);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return queryReadPrefixes(graph.value, parsed.value);
  };

  it("unions literal owners across joined clauses in canonical order", async () => {
    const entities = Array.from({length: 64}, (_, index) => `test:entity:${index}`);
    const expected = new Set(await Promise.all(entities.map(async entity => treeForKey(await virtualKeyForEntity(graph.value, entity)))));
    const query = entities.map(entity => `test:tenant(${JSON.stringify(entity)}, Tenant)`).join(", ");
    expect(await select(query)).toEqual(TREE_PREFIXES.filter(prefix => expected.has(prefix)));
  });

  it("deduplicates owners for repeated clauses on the same entity", async () => {
    const expected = treeForKey(await virtualKeyForEntity(graph.value, "test:a"));
    expect(await select('test:tenant("test:a", Tenant), test:enabled("test:a", Enabled)')).toEqual([expected]);
  });

  it("keeps the full vector when any entity is variable, numeric, or not a URI", async () => {
    for (const query of [
      'test:tenant("test:a", Tenant), test:tenant(Other, Tenant)',
      'test:tenant(42, Tenant)',
      'test:tenant("not a uri", Tenant)',
    ]) expect(await select(query)).toEqual(TREE_PREFIXES);
  });
});

describe("parallel read cut", () => {
  it("opens all owners before waiting and preserves vector order", async () => {
    const pending = TREE_PREFIXES.map(() => deferred<TreeSnapshot>());
    const started: string[] = [];
    const result = acquireParallelReadCut(prefix => {
      started.push(prefix);
      return pending[TREE_PREFIXES.indexOf(prefix)]!.promise;
    }, async () => {throw new Error("unexpected release");});
    expect(started).toEqual(TREE_PREFIXES);
    for (let index = pending.length - 1; index >= 0; index--) pending[index]!.resolve(lease(TREE_PREFIXES[index]!));
    expect((await result).map(value => value.prefix)).toEqual(TREE_PREFIXES);
  });

  it("acquires only the requested independent roots for a selective read", async () => {
    const requested = [TREE_PREFIXES[7]!, TREE_PREFIXES[2]!];
    const started: string[] = [];
    const cut = await acquireParallelReadCut(async prefix => {
      started.push(prefix);
      return lease(prefix);
    }, async () => {throw new Error("unexpected release");}, requested);
    expect(started).toEqual(requested);
    expect(cut.map(snapshot => snapshot.prefix)).toEqual(requested);
  });

  it("rejects empty or duplicate root selections before acquiring leases", async () => {
    const acquire = async (prefix: TreeSnapshot["prefix"]) => lease(prefix);
    await expect(acquireParallelReadCut(acquire, async () => {}, [])).rejects.toThrow("unique independent tree roots");
    await expect(acquireParallelReadCut(acquire, async () => {}, [TREE_PREFIXES[0]!, TREE_PREFIXES[0]!]))
      .rejects.toThrow("unique independent tree roots");
  });

  it("waits for late successes before releasing every acquired lease on failure", async () => {
    const late = deferred<TreeSnapshot>();
    const failure = new Error("owner busy");
    const releases: TreeSnapshot[][] = [];
    const result = acquireParallelReadCut(async prefix => {
      if (prefix === TREE_PREFIXES[0]) throw failure;
      if (prefix === TREE_PREFIXES[1]) return late.promise;
      return lease(prefix);
    }, async cut => {releases.push([...cut]);});
    const checked = expect(result).rejects.toBe(failure);
    await Promise.resolve();
    expect(releases).toEqual([]);
    late.resolve(lease(TREE_PREFIXES[1]!));
    await checked;
    expect(releases).toHaveLength(1);
    expect(releases[0]!.map(value => value.prefix)).toEqual(TREE_PREFIXES.slice(1));
  });

  it("rejects and releases a vector whose leases no longer overlap", async () => {
    let released = 0;
    await expect(acquireParallelReadCut(async prefix => ({...lease(prefix), expiresAtMs: 0}), async cut => {released = cut.length;}))
      .rejects.toThrow("expired during acquisition");
    expect(released).toBe(16);
  });
});
