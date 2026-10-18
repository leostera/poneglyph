import {connect, constants, type ClientHttp2Session} from "node:http2";
import {spawn} from "node:child_process";
import {open, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {isRecord} from "@leostera/poneglyph/storage-protocol";
import type {settings} from "./model.js";

type Reply = {status: number; json(): Promise<unknown>};
export async function h2Transport(origin: string, credentials: Record<string, string>, count: number) {
  const sessions: ClientHttp2Session[] = [];
  try {
    // 100 independently multiplexed requests per connection, not one Worker
    // invocation doing 100 writes. No stream/request is automatically retried.
    await Promise.all(Array.from({length: Math.max(1, Math.ceil(count / 100))}, async () => {
      const session = connect(origin); sessions.push(session);
      session.on("error", () => { /* Individual requests retain their own failure. */ });
      await new Promise<void>((accept, reject) => {
        const deadline = setTimeout(() => { session.destroy(); reject(new Error("H2 session unavailable")); }, 10_000);
        session.once("remoteSettings", settings => {
          clearTimeout(deadline);
          if ((settings.maxConcurrentStreams ?? 100) < 100 && count > 1) reject(new Error("Insufficient H2 stream allocation"));
          else accept();
        });
        session.once("error", () => { clearTimeout(deadline); reject(new Error("H2 session unavailable")); });
      });
    }));
  } catch (error) { for (const session of sessions) session.destroy(); throw error; }
  let next = 0;
  return {
    async request(path: string, init: {method?: string; body?: string; signal?: AbortSignal} = {}): Promise<Reply> {
      if (!/^\/[a-z-]+$/.test(path)) throw new Error("Invalid benchmark path");
      const session = sessions[next++ % sessions.length]!;
      return new Promise<Reply>((accept, reject) => {
        if (init.signal?.aborted) { reject(init.signal.reason); return; }
        const stream = session.request({...credentials, ":method": init.method ?? "POST", ":path": path,
          "content-type": "application/json"});
        let status = 0, size = 0, ended = false;
        const chunks: Buffer[] = [];
        const abort = () => { stream.close(constants.NGHTTP2_CANCEL); reject(init.signal?.reason ?? new Error("Cancelled")); };
        init.signal?.addEventListener("abort", abort, {once: true});
        stream.once("response", headers => { status = Number(headers[":status"]); });
        stream.on("data", (bytes: Buffer) => {
          size += bytes.length;
          if (size > 65_536) { stream.close(constants.NGHTTP2_CANCEL); reject(new Error("Reply exceeds budget")); return; }
          chunks.push(bytes);
        });
        stream.once("error", error => reject(error));
        stream.once("close", () => {
          init.signal?.removeEventListener("abort", abort);
          if (!ended) reject(new Error("H2 stream closed before complete reply"));
        });
        stream.once("end", () => {
          ended = true;
          const bytes = Buffer.concat(chunks);
          accept({status, async json() { return JSON.parse(bytes.toString("utf8")) as unknown; }});
        });
        stream.end(init.body);
      });
    },
    close() { for (const session of sessions) session.destroy(); },
  };
}

export async function startPrivatePreview(options: {
  here: string; artifact: string; scope: ReturnType<typeof settings>; port: number;
  environment: NodeJS.ProcessEnv; auditOnly?: boolean; suffix?: string;
}) {
  const {here, artifact, scope, port, environment} = options;
  const suffix = options.suffix ?? "direct";
  const config = resolve(artifact, `${suffix}.wrangler.json`);
  await writeFile(config, JSON.stringify({
    name: "poneglyph-validation-independent-write-operator", main: resolve(here, "operator.ts"),
    compatibility_date: "2026-10-18", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false,
    durable_objects: {bindings: [
      {name: "GRAPH_FACADES", class_name: "GraphCoordinatorDO", script_name: "poneglyph-mavplus-validation-worker"},
      {name: "GRAPH_LEDGERS", class_name: "GraphLedgerDO", script_name: "poneglyph-mavplus-validation-worker"},
    ]}, vars: {RUN_ID: scope.runId, CASE: scope.kind, COUNT: scope.count, AUDIT_ONLY: options.auditOnly === true},
  }, null, 2) + "\n");
  const log = await open(resolve(artifact, `${suffix}.log`), "w");
  const child = spawn(process.execPath, [resolve(here, "preview-session.cjs")], {
    cwd: here, detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"], env: {...environment,
      PONEGLYPH_WRITE_OPERATOR_CONFIG: config, PONEGLYPH_WRITE_OPERATOR_ENTRY: resolve(here, "operator.ts"),
      PONEGLYPH_WRITE_OPERATOR_PORT: String(port)},
  });
  const exited = new Promise<void>(accept => { child.once("exit", () => accept()); child.once("error", () => accept()); });
  const closeChild = async () => {
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    await Promise.race([exited, sleep(2_000)]);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await log.close();
  };
  try {
    const data = await new Promise<{origin: string; headers: Record<string, string>}>((accept, reject) => {
      const deadline = setTimeout(() => reject(new Error("Private preview unavailable")), 60_000);
      child.once("exit", () => { clearTimeout(deadline); reject(new Error("Private preview stopped")); });
      child.on("message", (message: unknown) => {
        if (isRecord(message) && message["type"] === "private-preview-startup-error") {
          clearTimeout(deadline); reject(new Error("Private preview stopped")); return;
        }
        if (!isRecord(message) || message["type"] !== "private-preview-ready" || !isRecord(message["proxyData"])) return;
        const proxy = message["proxyData"], url = proxy["userWorkerUrl"], headers = proxy["headers"];
        if (!isRecord(url) || url["protocol"] !== "https:" || typeof url["hostname"] !== "string" ||
            !url["hostname"].startsWith("poneglyph-validation-independent-write-operator.") || !url["hostname"].endsWith(".workers.dev") ||
            !isRecord(headers) || !Object.values(headers).every(value => typeof value === "string")) {
          clearTimeout(deadline); reject(new Error("Invalid private preview metadata")); return;
        }
        const credentials: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value !== "string" || key.startsWith(":")) continue;
          credentials[key.toLowerCase()] = value;
        }
        if (!credentials["cf-workers-preview-token"]) { clearTimeout(deadline); reject(new Error("Missing preview credential")); return; }
        clearTimeout(deadline); accept({origin: `https://${url["hostname"]}`, headers: credentials});
      });
    });
    const transport = await h2Transport(data.origin, data.headers, options.auditOnly ? 1 : scope.count);
    return {request: transport.request, async close() { transport.close(); await closeChild(); }};
  } catch (error) { await closeChild(); throw error; }
}
