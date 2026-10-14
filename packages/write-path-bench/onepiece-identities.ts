import { createHash } from "node:crypto";

/** MediaWiki page IDs are source locators, not public One Piece entity identities. */
declare const wikiPageIdBrand: unique symbol;
export type WikiPageId = string & { readonly [wikiPageIdBrand]: true };
export type OnePieceEntityKind = "entity" | "character" | "crew" | "ship" | "organization" | "role";
export type WikiPageIdParseResult =
  | Readonly<{ ok: true; value: WikiPageId }>
  | Readonly<{ ok: false; error: Readonly<{ path: string; message: string }> }>;

const UUID_NAMESPACE = Buffer.from("7f8e69a2c3045d1e8a1b6c2f0d9e4375", "hex");
const MAX_MEDIAWIKI_PAGE_ID = 9_223_372_036_854_775_807n;

export function parseWikiPageId(input: unknown, path = "wikiPageId"): WikiPageIdParseResult {
  if (typeof input !== "string" || input.length > 19 || !/^[1-9][0-9]*$/.test(input)) {
    return { ok: false, error: { path, message: "expected a positive decimal MediaWiki page ID" } };
  }

  try {
    if (BigInt(input) > MAX_MEDIAWIKI_PAGE_ID) {
      return { ok: false, error: { path, message: "MediaWiki page ID exceeds the signed 64-bit range" } };
    }
  } catch {
    return { ok: false, error: { path, message: "expected a positive decimal MediaWiki page ID" } };
  }

  return { ok: true, value: input as WikiPageId };
}

/**
 * Return a stable, opaque graph identity for a source page and semantic kind.
 * Page titles stay as labels/evidence; changing a title does not change this URI.
 */
export function onePieceEntityForPage(kind: OnePieceEntityKind, pageId: WikiPageId): string {
  const digest = createHash("sha1")
    .update(UUID_NAMESPACE)
    .update(`onepiece:v1:${kind}:mediawiki-page:${pageId}`, "utf8")
    .digest()
    .subarray(0, 16);

  // RFC 4122 version 5 UUID: deterministic SHA-1 name UUID under our namespace.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `onepiece:${kind}:${uuid}`;
}
