// Embeds the built browser client into the Worker bundle. The playground must
// not use a static-assets router: Worker-scoped Cloudflare Access (and the
// runtime's verified ctx.access) only applies to requests that reach Worker
// code, so every byte is served by the Worker itself. See RFD0006.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

export const CLIENT_ASSETS_MODULE = "virtual:playground-client";
export const CLIENT_OUT_DIR = resolve(import.meta.dirname, "../.client-dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json",
};
const TEXT = new Set([".html", ".js", ".css", ".svg", ".json"]);

/** Source for the virtual module: `export default { "/path": { type, etag, text? | base64? } }`. */
export async function clientAssetsModule(directory: string | undefined = CLIENT_OUT_DIR): Promise<string> {
  if (directory === undefined) return `export default {};`;
  const entries: Record<string, { type: string; etag: string; text?: string; base64?: string }> = {};
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const bytes = await readFile(full);
      const extension = extname(full);
      const etag = `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 22)}"`;
      const type = TYPES[extension] ?? "application/octet-stream";
      entries[`/${relative(directory!, full).split("\\").join("/")}`] = TEXT.has(extension) ? { type, etag, text: bytes.toString("utf8") } : { type, etag, base64: bytes.toString("base64") };
    }
  }
  await walk(directory);
  if (entries["/index.html"] === undefined) throw new Error(`No built client in ${directory}; run the client build first`);
  return `export default ${JSON.stringify(entries)};`;
}
