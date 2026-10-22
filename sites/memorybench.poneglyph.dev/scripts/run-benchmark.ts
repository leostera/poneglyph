import { execFileSync, spawn } from "node:child_process";
import { readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import manifest from "../evidence/datasets.json" with { type: "json" };
import { MODEL } from "../bench/model.js";

const [checkoutArg, benchmark, variant, runId, limit] = process.argv.slice(2);
if (!checkoutArg || !["locomo", "longmemeval"].includes(benchmark ?? "") || !["a", "b"].includes(variant ?? "") || !runId || !/^[a-z0-9-]+$/.test(runId)) throw new Error("Usage: run-benchmark.ts CHECKOUT locomo|longmemeval a|b RUN_ID [SMOKE_LIMIT]");
if (limit !== undefined && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100)) throw new Error("Invalid explicit smoke limit; omit for full runs");
const checkout = resolve(checkoutArg), bun = process.env.MEMORYBENCH_BUN ?? "bun";
if (execFileSync(bun, ["--version"], { encoding: "utf8" }).trim() !== "1.4.2") throw new Error("Use Bun 1.4.2 via MEMORYBENCH_BUN or PATH");
execFileSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "prepare-upstream.ts"), checkout], { stdio: "inherit" });
const dataDirectory = process.env.MEMORYBENCH_DATA_DIR;
if (!dataDirectory) throw new Error("MEMORYBENCH_DATA_DIR is required; no implicit dataset downloads");
const source = resolve(dataDirectory, benchmark === "locomo" ? "locomo10.json" : "lme_s.complete.json");
const destination = resolve(checkout, benchmark === "locomo" ? "data/benchmarks/locomo/locomo10.json" : "data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json");
const expected = manifest.datasets.find(d => d.benchmark === benchmark)!;
function hash(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
if (hash(source) !== expected.sha256) throw new Error("Source dataset does not match the pinned hash");
if (existsSync(destination) && hash(destination) !== expected.sha256) throw new Error("Refusing to replace an unrelated upstream dataset");
if (!existsSync(destination)) { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); }
const args = ["run", "src/index.ts", "run", "-p", `poneglyph-${variant}`, "-b", benchmark!, "-r", runId, "-j", MODEL, "-m", MODEL, ...(limit ? ["-l", limit] : [])];
const child = spawn(bun, args, { cwd: checkout, env: process.env, stdio: "inherit" });
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
