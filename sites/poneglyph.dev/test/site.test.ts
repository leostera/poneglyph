import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BENEFITS, LINKS } from "../src/content.ts";

describe("poneglyph.dev", () => {
  it("ships a 404 page for unknown paths", () => {
    expect(readFileSync(new URL("../public/404.html", import.meta.url), "utf8")).toContain('href="/"');
  });

  it("links only to https destinations", () => {
    for (const url of Object.values(LINKS)) expect(new URL(url).protocol).toBe("https:");
  });

  it("keeps benefit copy short", () => {
    for (const benefit of BENEFITS) expect(benefit.body.split(" ").length).toBeLessThanOrEqual(30);
  });

  it("does not let the CSP block same-origin scripts", () => {
    const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    expect(headers).toContain("script-src 'self'");
  });
});
