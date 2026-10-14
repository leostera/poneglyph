import { SaxesParser } from "saxes";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactInput } from "@leostera/poneglyph";
import { ROOT } from "./build.js";

export function entityForTitle(title: string): string {
  // Exact title bytes preserve identity; lossy lowercase/slugs merged unrelated pages.
  return `wiki:onepiece:page:${encodeURIComponent(title)}`;
}
export function pageFacts(title: string, namespace: string, text: string): FactInput[] {
  const entity = entityForTitle(title);
  const make = (field: string, value: FactInput["value"]): FactInput => ({ source: "fixture:onepiece-fandom", entity, field, value, retraction: false });
  const facts = [make("wiki:page:title", { type: "text", value: title }),
    make("wiki:page:namespace", { type: "number", value: namespace }),
    make("wiki:page:text_bytes", { type: "number", value: String(Buffer.byteLength(text)) })];
  const categories = new Set<string>(), links = new Set<string>();
  for (const match of text.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
    const target = match[1]?.split("|")[0]?.trim();
    if (!target) continue;
    if (target.startsWith("Category:")) { if (categories.size < 8) categories.add(target); }
    else if (links.size < 16) links.add(target);
  }
  for (const category of categories) facts.push(make("wiki:page:category", { type: "text", value: category }));
  for (const link of links) facts.push(make("wiki:page:link", { type: "text", value: link }));
  return facts;
}
export async function prepareCorpus(xml: string) {
  await mkdir(resolve(ROOT, ".data"), { recursive: true });
  const output = createWriteStream(resolve(ROOT, ".data/facts.ndjson"));
  const xmlHash = createHash("sha256"), factHash = createHash("sha256");
  const parser = new SaxesParser({ xmlns: false });
  const stack: string[] = [];
  let page: { title: string; namespace: string; text: string; sawText: boolean } | undefined;
  let capture: "title" | "ns" | "text" | undefined;
  let captured = "", pages = 0, factCount = 0, xmlBytes = 0;
  let pending: string[] = [];
  parser.on("opentag", tag => {
    const parent = stack.at(-1);
    stack.push(tag.name);
    if (tag.name === "page") page = { title: "", namespace: "0", text: "", sawText: false };
    if (page && parent === "page" && (tag.name === "title" || tag.name === "ns")) { capture = tag.name; captured = ""; }
    if (page && tag.name === "text" && !page.sawText) { page.sawText = true; capture = "text"; captured = ""; }
  });
  parser.on("text", text => { if (capture) captured += text; });
  parser.on("cdata", text => { if (capture) captured += text; });
  parser.on("closetag", tag => {
    if (page && tag.name === capture) {
      if (capture === "ns") page.namespace = captured;
      else if (capture === "title") page.title = captured;
      else page.text = captured;
      capture = undefined;
    }
    if (tag.name === "page" && page) {
      if (!page.title) throw new Error("page without title");
      pages++;
      for (const fact of pageFacts(page.title, page.namespace, page.text)) {
        const line = JSON.stringify(fact) + "\n";
        pending.push(line); factHash.update(line); factCount++;
      }
      page = undefined;
    }
    stack.pop();
  });
  // UTF-8 decoding must retain split multibyte characters across file chunks.
  const decoder = new TextDecoder();
  for await (const chunk of createReadStream(xml)) {
    xmlHash.update(chunk); xmlBytes += chunk.length;
    parser.write(decoder.decode(chunk, { stream: true }));
    for (const line of pending) if (!output.write(line)) await once(output, "drain");
    pending = [];
  }
  parser.write(decoder.decode()); parser.close();
  for (const line of pending) if (!output.write(line)) await once(output, "drain");
  output.end(); await once(output, "finish");
  const manifest = { extractionVersion: 1, xmlSha256: xmlHash.digest("hex"), xmlBytes, pages, facts: factCount,
    factsSha256: factHash.digest("hex"), policies: { identity: "exact percent-encoded title", categoriesPerPage: 8,
      linksPerPage: 16, fullTextStored: false, supplementalFacts: 0, namespaceFilter: "none" } };
  await writeFile(resolve(ROOT, ".data/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareCorpus(process.argv[2] ?? resolve(ROOT, "../../tests/fixtures/cache/onepiece-pages-current.xml")), null, 2));
}
