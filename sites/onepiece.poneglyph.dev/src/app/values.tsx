import { Badge } from "@cloudflare/kumo/components/badge";
import type { TypedValue } from "./api.ts";

const WIKI_PAGE = "wiki:onepiece:page:";
const SEMANTIC = /^onepiece:(character|crew|ship|entity|kind):(.+)$/;

export function decodeWikiTitle(value: string): string | undefined {
  if (!value.startsWith(WIKI_PAGE)) return undefined;
  try { return decodeURIComponent(value.slice(WIKI_PAGE.length)); } catch { return undefined; }
}

// Render a tagged Datalog value. Entity-looking strings get a compact,
// readable form while the exact value stays available on hover.
export function ValueCell({ value }: { value: TypedValue }) {
  if (value.type === "integer") return <span className="font-code tabular-nums text-kumo-default">{value.value}</span>;
  const title = decodeWikiTitle(value.value);
  if (title !== undefined) {
    return (
      <span className="inline-flex items-center gap-1.5" title={value.value}>
        <Badge variant="blue">page</Badge>
        <span className="text-kumo-default">{title}</span>
      </span>
    );
  }
  const semantic = SEMANTIC.exec(value.value);
  if (semantic) {
    const [, kind, id] = semantic;
    return (
      <span className="inline-flex items-center gap-1.5" title={value.value}>
        <Badge variant={kind === "crew" ? "orange" : kind === "ship" ? "teal" : kind === "character" ? "purple" : "neutral"}>{kind}</Badge>
        <span className="font-code text-xs text-kumo-subtle">{kind === "kind" ? id : `${id!.slice(0, 8)}…`}</span>
      </span>
    );
  }
  return <span className="text-kumo-default break-words">{value.value}</span>;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes} B`;
}

export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
