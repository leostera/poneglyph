// Write load from the edge: generator Durable Objects each run `writers` loops
// that post small transactions on random entities through the DATABASE
// service binding, so every write is its own invocation of this Worker.
import { DurableObject } from "cloudflare:workers";
import type { StorageEnv } from "../../../packages/poneglyph/src/storage/environment.ts";
import { treeCoordinatorName, treeForKey } from "../../../packages/poneglyph/src/storage/forest.ts";
import { virtualKeyForEntity } from "../../../packages/poneglyph/src/storage/keys.ts";
import type { CeilingProbe, ProbeMode } from "./probe.ts";

export type BenchEnv = StorageEnv & Readonly<{
  DATABASE: Fetcher;
  LOAD_GENERATOR: DurableObjectNamespace<LoadGenerator>;
  CEILING_PROBE: DurableObjectNamespace<CeilingProbe>;
}>;

/** Instead of graph writes, call one probe object directly (RFD0011). */
export type ProbeLoad = Readonly<{name: string; mode: ProbeMode; transport: "fetch" | "rpc" | "tree"}>;

export type WriteLoad = Readonly<{
  graph: string;
  generator: number;
  writers: number;
  seconds: number;
  factsPerTransaction: number;
  /** Entities are `bench:entity:${n}` for n below this. */
  entitySpace: number;
  /** Only entities owned by this 4-bit owner prefix, to load one owner tree. */
  owner?: string;
  probe?: ProbeLoad;
  startAt: number;
}>;

export type WriteLoadResult = Readonly<{
  accepted: number;
  statuses: Record<string, number>;
  latencies: number[];
  perSecond: Record<string, number>;
  /** Summed Server-Timing durations per name, and how many responses reported each. */
  timings: Record<string, {totalMs: number; count: number}>;
}>;

export class LoadGenerator extends DurableObject<BenchEnv> {
  async run(load: WriteLoad): Promise<WriteLoadResult> {
    const statuses: Record<string, number> = {}, perSecond: Record<string, number> = {}, latencies: number[] = [];
    const timings: Record<string, {totalMs: number; count: number}> = {};
    let accepted = 0;
    // Entities in the requested owner, found by sampling before the clock starts.
    const pool: string[] = [];
    if (load.owner !== undefined) {
      for (let attempts = 0; pool.length < 2_000 && attempts < 100_000; attempts++) {
        const entity = `bench:entity:${Math.floor(Math.random() * load.entitySpace)}`;
        if (treeForKey(await virtualKeyForEntity(load.graph, entity)) === load.owner) pool.push(entity);
      }
    }
    const pick = () => pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)]! : `bench:entity:${Math.floor(Math.random() * load.entitySpace)}`;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, load.startAt - Date.now())));
    const deadline = load.startAt + load.seconds * 1000;
    await Promise.all(Array.from({length: load.writers}, async (_, writer) => {
      for (let n = 0; Date.now() < deadline; n++) {
        const facts = Array.from({length: load.factsPerTransaction}, (_, index) => ({
          source: `bench:g${load.generator}w${writer}`,
          entity: pick(),
          field: "bench:value",
          value: {type: "text", value: `g${load.generator}w${writer}n${n}i${index}`},
          retraction: false,
        }));
        const started = Date.now();
        let status: string;
        try {
          const body = JSON.stringify({facts});
          if (load.probe?.transport === "tree") {
            // One owner tree alone: the lock and finish a single-owner write makes.
            const tree = this.env.GRAPH_TREES.getByName(treeCoordinatorName(load.graph, load.owner as never));
            const identity = {graphId: load.graph, prefix: load.owner, txId: `poneglyph:tx:probe:${load.generator}:${writer}:${n}`,
              payloadHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"), identityTimeMs: Date.now()};
            const lock = await tree.fetch("https://owner.internal/_tree-lock", {method: "POST",
              body: JSON.stringify({...identity, entities: [facts[0]!.entity], directoryEpoch: 0, gate: true})});
            const ticket = await lock.json() as Record<string, unknown>;
            if (!lock.ok) throw new Error(`lock ${lock.status} ${JSON.stringify(ticket).slice(0, 60)}`);
            const finish = await tree.fetch("https://owner.internal/_tree-finish", {method: "POST",
              body: JSON.stringify({...identity, reservationTicket: ticket["reservationTicket"], publicationSeq: ticket["publicationSeq"], singleOwner: true})});
            await finish.arrayBuffer();
            if (!finish.ok) throw new Error(`finish ${finish.status}`);
            const done = Date.now();
            latencies.push(done - started); accepted++;
            const second = String(Math.floor((done - load.startAt) / 1000));
            perSecond[second] = (perSecond[second] ?? 0) + 1;
            statuses["200"] = (statuses["200"] ?? 0) + 1;
            continue;
          }
          if (load.probe?.transport === "rpc") {
            await this.env.CEILING_PROBE.getByName(load.probe.name).hit(load.probe.mode, body);
            const done = Date.now();
            latencies.push(done - started); accepted++;
            const second = String(Math.floor((done - load.startAt) / 1000));
            perSecond[second] = (perSecond[second] ?? 0) + 1;
            statuses["200"] = (statuses["200"] ?? 0) + 1;
            continue;
          }
          const response = load.probe !== undefined
            ? await this.env.CEILING_PROBE.getByName(load.probe.name).fetch(`https://probe.internal/${load.probe.mode}`, {method: "POST", body})
            : await this.env.DATABASE.fetch(`https://database.internal/v1/graphs/${load.graph}/transactions`, {
              method: "POST", headers: {"content-type": "application/json"}, body,
            });
          status = String(response.status);
          if (response.ok) {
            await response.arrayBuffer();
            for (const part of (response.headers.get("server-timing") ?? "").split(",")) {
              const match = /^\s*([\w-]+);dur=(\d+)/.exec(part);
              if (!match) continue;
              const entry = timings[match[1]!] ??= {totalMs: 0, count: 0};
              entry.totalMs += Number(match[2]); entry.count++;
            }
            const done = Date.now();
            latencies.push(done - started); accepted++;
            const second = String(Math.floor((done - load.startAt) / 1000));
            perSecond[second] = (perSecond[second] ?? 0) + 1;
          } else {
            const text = await response.text();
            status = `${response.status} ${text.slice(0, 80)}`;
          }
        } catch (error) {
          status = `error ${String(error).slice(0, 80)}`;
        }
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }));
    return {accepted, statuses, latencies, perSecond, timings};
  }
}

export async function runWriteBench(request: Request, env: BenchEnv): Promise<Response> {
  const input = await request.json() as Partial<Record<string, unknown>>;
  const count = (name: string, fallback: number, max: number) => {
    const value = input[name] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be 1..${max}`);
    return value;
  };
  const graph = typeof input["graph"] === "string" ? input["graph"] : `bench-${crypto.randomUUID()}`;
  const generators = count("generators", 4, 64), writers = count("writers", 8, 64), seconds = count("seconds", 10, 120);
  const factsPerTransaction = count("factsPerTransaction", 1, 100), entitySpace = count("entitySpace", 1_000_000, 1_000_000_000);
  const owner = typeof input["owner"] === "string" && /^[01]{4}$/.test(input["owner"]) ? input["owner"] : undefined;
  const startAt = Date.now() + (owner === undefined ? 2_000 : 8_000);
  const rawProbe = input["probe"] as Partial<Record<string, unknown>> | undefined;
  const probe: ProbeLoad | undefined = rawProbe === undefined ? undefined : {
    name: typeof rawProbe["name"] === "string" ? rawProbe["name"] : `probe-${crypto.randomUUID()}`,
    mode: rawProbe["mode"] === "write1" || rawProbe["mode"] === "write3" ? rawProbe["mode"] : "noop",
    transport: rawProbe["transport"] === "rpc" || rawProbe["transport"] === "tree" ? rawProbe["transport"] : "fetch",
  };
  const results = await Promise.all(Array.from({length: generators}, (_, generator) =>
    env.LOAD_GENERATOR.getByName(`generator-${generator}`).run({graph, generator, writers, seconds, factsPerTransaction, entitySpace, startAt, ...(owner === undefined ? {} : {owner}), ...(probe === undefined ? {} : {probe})})));
  const latencies = results.flatMap(result => result.latencies).sort((a, b) => a - b);
  const statuses: Record<string, number> = {}, perSecond: Record<string, number> = {};
  const timings: Record<string, {totalMs: number; count: number}> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result.timings)) {
      const entry = timings[key] ??= {totalMs: 0, count: 0}; entry.totalMs += value.totalMs; entry.count += value.count;
    }
    for (const [key, value] of Object.entries(result.statuses)) statuses[key] = (statuses[key] ?? 0) + value;
    for (const [key, value] of Object.entries(result.perSecond)) perSecond[key] = (perSecond[key] ?? 0) + value;
  }
  const accepted = results.reduce((sum, result) => sum + result.accepted, 0);
  const pick = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? null;
  return Response.json({
    graph, generators, writers, seconds, factsPerTransaction, accepted,
    writesPerSecond: accepted / seconds, factsPerSecond: accepted * factsPerTransaction / seconds,
    latencyMs: {p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), max: latencies.at(-1) ?? null},
    meanServerTimingMs: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Math.round(value.totalMs / value.count)])),
    perSecond, statuses,
  });
}
