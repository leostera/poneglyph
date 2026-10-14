import { createHash } from "node:crypto";
import { SaxesParser } from "saxes";
import { parseWikiPageId, type WikiPageId } from "./onepiece-identities.js";

export type WikiDumpPage = Readonly<{
  id: WikiPageId;
  title: string;
  namespace: string;
  text: string;
  redirectTarget?: string;
}>;
export type WikiXmlChunks = AsyncIterable<Uint8Array>;
export type WikiXmlSummary = Readonly<{ sha256: string; bytes: number; pages: number }>;

/** Stream MediaWiki XML with backpressure; page text is retained only for the visitor call. */
export async function visitMediaWikiPages(
  chunks: WikiXmlChunks,
  visit: (page: WikiDumpPage) => void | Promise<void>,
): Promise<WikiXmlSummary> {
  const parser = new SaxesParser({ xmlns: false });
  const sourceHash = createHash("sha256");
  let sourceBytes = 0;
  let pageCount = 0;
  const decoder = new TextDecoder();
  const stack: string[] = [];
  const pending: WikiDumpPage[] = [];
  let page: { id: string; title: string; namespace: string; text: string; redirectTarget?: string; sawText: boolean } | undefined;
  let capture: "id" | "title" | "namespace" | "text" | undefined;
  let captured = "";
  let parserError: Error | undefined;

  parser.on("error", error => { parserError ??= error; });
  parser.on("opentag", tag => {
    const parent = stack.at(-1);
    stack.push(tag.name);
    if (tag.name === "page") {
      page = { id: "", title: "", namespace: "0", text: "", sawText: false };
    }
    if (!page) return;
    if (parent === "page" && tag.name === "redirect") {
      const target = tag.attributes["title"];
      if (typeof target === "string") page.redirectTarget = target;
    }
    if (parent === "page" && (tag.name === "id" || tag.name === "title" || tag.name === "ns")) {
      capture = tag.name === "id" ? "id" : tag.name === "title" ? "title" : "namespace";
      captured = "";
    }
    if (tag.name === "text" && !page.sawText) {
      page.sawText = true;
      capture = "text";
      captured = "";
    }
  });
  parser.on("text", text => { if (capture) captured += text; });
  parser.on("cdata", text => { if (capture) captured += text; });
  parser.on("closetag", tag => {
    if (page && capture === "id" && tag.name === "id") page.id = captured;
    else if (page && capture === "title" && tag.name === "title") page.title = captured;
    else if (page && capture === "namespace" && tag.name === "ns") page.namespace = captured;
    else if (page && capture === "text" && tag.name === "text") page.text = captured;
    if (capture && (tag.name === "id" || tag.name === "title" || tag.name === "ns" || tag.name === "text")) capture = undefined;

    if (tag.name === "page" && page) {
      const id = parseWikiPageId(page.id, "page.id");
      if (!id.ok) throw new TypeError(id.error.message);
      if (!page.title) throw new TypeError("MediaWiki page is missing a title");
      pageCount++;
      pending.push(Object.freeze({
        id: id.value,
        title: page.title,
        namespace: page.namespace,
        text: page.text,
        ...(page.redirectTarget === undefined ? {} : { redirectTarget: page.redirectTarget }),
      }));
      page = undefined;
      capture = undefined;
      captured = "";
    }
    stack.pop();
  });

  const visitPending = async (): Promise<void> => {
    if (parserError) throw new SyntaxError("invalid MediaWiki XML", { cause: parserError });
    while (pending.length > 0) await visit(pending.shift()!);
  };

  for await (const chunk of chunks) {
    sourceHash.update(chunk);
    sourceBytes += chunk.byteLength;
    parser.write(decoder.decode(chunk, { stream: true }));
    await visitPending();
  }
  parser.write(decoder.decode());
  parser.close();
  await visitPending();
  return Object.freeze({ sha256: sourceHash.digest("hex"), bytes: sourceBytes, pages: pageCount });
}
