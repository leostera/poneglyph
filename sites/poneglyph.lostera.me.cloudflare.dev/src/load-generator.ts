// Write load from the edge: generator Durable Objects each run `writers` loops
// that post small transactions on random entities through the DATABASE
// service binding, so every write is its own invocation of this Worker.
import { DurableObject } from "cloudflare:workers";
import type { StorageEnv } from "../../../packages/poneglyph/src/storage/environment.ts";

export type BenchEnv = StorageEnv & Readonly<{
  DATABASE: Fetcher;
  LOAD_GENERATOR: DurableObjectNamespace<LoadGenerator>;
}>;

export type WriteLoad = Readonly<{
  graph: string;
  generator: number;
  writers: number;
  seconds: number;
  factsPerTransaction: number;
  /** Entities are `bench:entity:${n}` for n below this. */
  entitySpace: number;
  startAt: number;
}>;

export type WriteLoadResult = Readonly<{
  accepted: number;
  statuses: Record<string, number>;
  latencies: number[];
  perSecond: Record<string, number>;
}>;

export class LoadGenerator extends DurableObject<BenchEnv> {
  async run(load: WriteLoad): Promise<WriteLoadResult> {
    const statuses: Record<string, number> = {}, perSecond: Record<string, number> = {}, latencies: number[] = [];
    let accepted = 0;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, load.startAt - Date.now())));
    const deadline = load.startAt + load.seconds * 1000;
    await Promise.all(Array.from({length: load.writers}, async (_, writer) => {
      for (let n = 0; Date.now() < deadline; n++) {
        const facts = Array.from({length: load.factsPerTransaction}, (_, index) => ({
          source: `bench:g${load.generator}w${writer}`,
          entity: `bench:entity:${Math.floor(Math.random() * load.entitySpace)}`,
          field: "bench:value",
          value: {type: "text", value: `g${load.generator}w${writer}n${n}i${index}`},
          retraction: false,
        }));
        const started = Date.now();
        let status: string;
        try {
          const response = await this.env.DATABASE.fetch(`https://database.internal/v1/graphs/${load.graph}/transactions`, {
            method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({facts}),
          });
          status = String(response.status);
          if (response.ok) {
            await response.arrayBuffer();
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
    return {accepted, statuses, latencies, perSecond};
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
  const startAt = Date.now() + 2_000;
  const results = await Promise.all(Array.from({length: generators}, (_, generator) =>
    env.LOAD_GENERATOR.getByName(`generator-${generator}`).run({graph, generator, writers, seconds, factsPerTransaction, entitySpace, startAt})));
  const latencies = results.flatMap(result => result.latencies).sort((a, b) => a - b);
  const statuses: Record<string, number> = {}, perSecond: Record<string, number> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result.statuses)) statuses[key] = (statuses[key] ?? 0) + value;
    for (const [key, value] of Object.entries(result.perSecond)) perSecond[key] = (perSecond[key] ?? 0) + value;
  }
  const accepted = results.reduce((sum, result) => sum + result.accepted, 0);
  const pick = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? null;
  return Response.json({
    graph, generators, writers, seconds, factsPerTransaction, accepted,
    writesPerSecond: accepted / seconds, factsPerSecond: accepted * factsPerTransaction / seconds,
    latencyMs: {p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), max: latencies.at(-1) ?? null},
    perSecond, statuses,
  });
}
