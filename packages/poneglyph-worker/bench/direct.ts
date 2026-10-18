import {build} from "esbuild";
import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {startPrivatePreview} from "./private-preview.js";

/** Fixed read-only remote probe. Does not deploy its service dependency. */
export async function startReadPreview(options: Readonly<{
  artifact: string; runId: string; port: number; concurrency: number; environment: NodeJS.ProcessEnv;
}>) {
  const main = resolve(options.artifact, "operator.mjs");
  await build({entryPoints: [resolve(import.meta.dirname, "operator.ts")], outfile: main, bundle: true,
    platform: "browser", format: "esm", target: "es2024", external: ["cloudflare:*", "node:*"]});
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  await writeFile(resolve(options.artifact, "probe-source.json"), JSON.stringify({
    operatorSourceSha256: digest(await readFile(resolve(import.meta.dirname, "operator.ts"))),
    operatorInputBundleSha256: digest(await readFile(main)),
    previewChildSha256: digest(await readFile(resolve(import.meta.dirname, "preview-session.cjs"))),
  }, null, 2) + "\n");
  return startPrivatePreview({role: "read", artifact: options.artifact, port: options.port,
    concurrency: options.concurrency, environment: options.environment, suffix: "direct", configuration: {
      main, compatibility_date: "2026-10-18", compatibility_flags: ["nodejs_compat"],
      services: [{binding: "PONEGLYPH", service: "poneglyph-mavplus-validation-worker", props: {clientId: "playground-loader"}}],
      vars: {RUN_ID: options.runId},
    }});
}
