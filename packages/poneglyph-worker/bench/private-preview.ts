import {spawn} from "node:child_process";
import {open, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {isRecord} from "@leostera/poneglyph/storage-protocol";
import {h2Transport} from "./http2.js";

type Role = "read" | "write";
export const previewName = (role: Role) => `poneglyph-validation-independent-${role}-operator`;

/** Credentials stay in the Node process/IPC; errors never include input text. */
export function parsePreviewAuthority(raw: unknown, role: Role): Readonly<{origin: string; headers: Readonly<Record<string, string>>}> {
  const fail = () => new Error("Invalid private preview authority");
  if (!isRecord(raw) || !isRecord(raw["userWorkerUrl"]) || !isRecord(raw["headers"])) throw fail();
  const url = raw["userWorkerUrl"], host = url["hostname"];
  if (url["protocol"] !== "https:" || typeof host !== "string" || host.length > 253 ||
      !host.startsWith(`${previewName(role)}.`) || !host.endsWith(".workers.dev") ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ||
      ["username", "password", "search", "hash"].some(key => url[key] !== undefined && url[key] !== "") ||
      url["port"] !== undefined && url["port"] !== "" && url["port"] !== "443" ||
      url["pathname"] !== undefined && url["pathname"] !== "/") throw fail();
  const entries = Object.entries(raw["headers"]);
  if (entries.length < 1 || entries.length > 16) throw fail();
  const headers: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/.test(normalized) || typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value) ||
        ["host", "connection", "transfer-encoding", "upgrade"].includes(normalized) || Object.hasOwn(headers, normalized)) throw fail();
    bytes += key.length + value.length;
    if (bytes > 16_384) throw fail();
    headers[normalized] = value;
  }
  if ((headers["cf-workers-preview-token"]?.length ?? 0) < 20) throw fail();
  return Object.freeze({origin: `https://${host}`, headers: Object.freeze(headers)});
}

/** Trusted adapters supply fixed configs, not caller-selected destinations. */
export async function startPrivatePreview(options: Readonly<{
  role: Role; artifact: string; configuration: Readonly<Record<string, unknown>>;
  port: number; concurrency: number; environment: NodeJS.ProcessEnv; suffix: string;
}>) {
  const {artifact, role, suffix} = options;
  const config = resolve(artifact, `${suffix}.wrangler.json`);
  await writeFile(config, JSON.stringify({...options.configuration, name: previewName(role),
    workers_dev: false, preview_urls: false}, null, 2) + "\n");
  const log = await open(resolve(artifact, `${suffix}.log`), "w", 0o600);
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "preview-session.cjs")], {
    cwd: import.meta.dirname, detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"], env: {...options.environment,
      PONEGLYPH_PREVIEW_CONFIG: config, PONEGLYPH_PREVIEW_NAME: previewName(role), PONEGLYPH_PREVIEW_PORT: String(options.port)},
  });
  const exited = new Promise<void>(accept => { child.once("exit", () => accept()); child.once("error", () => accept()); });
  const closeChild = async () => {
    if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    await Promise.race([exited, sleep(2_000)]);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await log.close();
  };
  try {
    const authority = await new Promise<ReturnType<typeof parsePreviewAuthority>>((accept, reject) => {
      const deadline = setTimeout(() => reject(new Error("Private preview unavailable")), 60_000);
      child.once("exit", () => { clearTimeout(deadline); reject(new Error("Private preview stopped")); });
      child.once("error", () => { clearTimeout(deadline); reject(new Error("Private preview stopped")); });
      child.on("message", (message: unknown) => {
        if (isRecord(message) && message["type"] === "private-preview-startup-error") {
          clearTimeout(deadline); reject(new Error("Private preview stopped")); return;
        }
        if (!isRecord(message) || message["type"] !== "private-preview-ready") return;
        try { const parsed = parsePreviewAuthority(message["proxyData"], role); clearTimeout(deadline); accept(parsed); }
        catch {
          const raw = message["proxyData"], url = isRecord(raw) ? raw["userWorkerUrl"] : undefined;
          const headers = isRecord(raw) ? raw["headers"] : undefined;
          console.error(JSON.stringify({event: "poneglyph.bench.preview_authority_rejected",
            urlRecord: isRecord(url), headerRecord: isRecord(headers),
            https: isRecord(url) && url["protocol"] === "https:",
            roleHost: isRecord(url) && typeof url["hostname"] === "string" && url["hostname"].startsWith(`${previewName(role)}.`),
            defaultPort: isRecord(url) && (url["port"] === undefined || url["port"] === "" || url["port"] === "443" || url["port"] === 443),
            rootPath: isRecord(url) && (url["pathname"] === undefined || url["pathname"] === "" || url["pathname"] === "/"),
            noCredentialsOrQuery: isRecord(url) && ["username", "password", "search", "hash"].every(key => url[key] === undefined || url[key] === ""),
            headerCountWithinBudget: isRecord(headers) && Object.keys(headers).length <= 16,
          }));
          clearTimeout(deadline); reject(new Error("Invalid private preview authority"));
        }
      });
    });
    const transport = await h2Transport(authority.origin, authority.headers, options.concurrency);
    return {request: transport.request, async close() { transport.close(); await closeChild(); }};
  } catch (error) { await closeChild(); throw error; }
}
