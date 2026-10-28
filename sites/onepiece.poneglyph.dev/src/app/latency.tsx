import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import type { QueryMetrics } from "./api.ts";
import { formatBytes, formatMs, percentile } from "./values.tsx";

export type HistoryEntry = Readonly<{
  id: number; at: Date; kind: "query" | "write" | "schema"; label: string; ok: boolean;
  roundTripMs: number; serverMs?: number; databaseMs?: number; rows?: number; snapshotSeq?: number;
}>;

function Stat({ label, value, hint, accent }: { label: string; value: string; hint: string; accent?: boolean }) {
  return (
    <div title={hint} className={`flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-kumo-hairline px-3 py-2 ${accent ? "bg-kumo-tint" : "bg-kumo-base"}`}>
      <span className="text-xs text-kumo-subtle">{label}</span>
      <span className="font-code text-lg font-semibold tabular-nums text-kumo-default">{value}</span>
    </div>
  );
}

// Where the time went for one query, from the browser's perspective inward.
export function LatencyBreakdown({ roundTripMs, serverMs, metrics }: { roundTripMs: number; serverMs: number; metrics?: QueryMetrics }) {
  const timing = metrics?.timing;
  const segments = [
    { label: "Network + edge", ms: Math.max(0, roundTripMs - serverMs), className: "bg-kumo-line", hint: "Your browser to Cloudflare and back." },
    { label: "Worker + RPC", ms: Math.max(0, serverMs - (timing?.executionMs ?? 0)), className: "bg-kumo-badge-purple", hint: "The playground Worker and its call to Poneglyph." },
    { label: "Snapshot", ms: timing?.snapshotMs ?? 0, className: "bg-kumo-warning", hint: "Pick a consistent point to read from." },
    { label: "Evaluate", ms: timing?.evaluationMs ?? 0, className: "bg-kumo-brand", hint: "Scanning and joining." },
    { label: "Release", ms: timing?.releaseMs ?? 0, className: "bg-kumo-success", hint: "Clean up after reading." },
  ];
  const total = Math.max(1, segments.reduce((sum, segment) => sum + segment.ms, 0));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-kumo-recessed">
        {segments.map(segment => segment.ms > 0 && (
          <div key={segment.label} title={`${segment.label}: ${formatMs(segment.ms)}. ${segment.hint}`} className={`${segment.className} h-full`} style={{ width: `${(segment.ms / total) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map(segment => (
          <span key={segment.label} title={segment.hint} className="inline-flex items-center gap-1.5 text-xs text-kumo-subtle">
            <span className={`${segment.className} inline-block size-2 rounded-full`} />{segment.label} <span className="font-code text-kumo-default">{formatMs(segment.ms)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function QueryStats({ roundTripMs, serverMs, metrics, rows, snapshotSeq }: { roundTripMs: number; serverMs: number; metrics: QueryMetrics; rows: number; snapshotSeq: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat accent label="Round trip" value={formatMs(roundTripMs)} hint="In your browser." />
        <Stat label="Worker" value={formatMs(serverMs)} hint="In the playground Worker." />
        <Stat label="Database" value={formatMs(metrics.timing?.executionMs)} hint="Inside Poneglyph." />
        <Stat label="Evaluation" value={formatMs(metrics.timing?.evaluationMs)} hint="Scanning and joining." />
      </div>
      <LatencyBreakdown roundTripMs={roundTripMs} serverMs={serverMs} metrics={metrics} />
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="neutral">{rows} {rows === 1 ? "row" : "rows"}</Badge>
        {(metrics.cacheHits ?? 0) > 0 && <Tooltip content="Served from cache; nothing changed since the last identical query."><Badge variant="success">cache hit</Badge></Tooltip>}
        <Badge variant="outline">{metrics.shardRequests} shard requests</Badge>
        <Badge variant="outline">{metrics.tuplesRead.toLocaleString()} facts scanned</Badge>
        <Badge variant="outline">{formatBytes(metrics.bytesRead)} read</Badge>
      </div>
      <details className="text-xs text-kumo-subtle">
        <summary className="cursor-pointer select-none">Details</summary>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Tooltip content="Every row was read from the same consistent point in time. The number isn't comparable across queries."><Badge variant="neutral">snapshot {snapshotSeq}</Badge></Tooltip>
          <Badge variant="outline">{metrics.scanCalls} scans</Badge>
          {metrics.distinctShardsTouched !== undefined && <Badge variant="outline">{metrics.distinctShardsTouched} shards touched</Badge>}
          {metrics.treeReadLeaseAcquisitions !== undefined && <Badge variant="outline">{metrics.treeReadLeaseAcquisitions} read leases</Badge>}
        </div>
      </details>
    </div>
  );
}

function Sparkline({ entries }: { entries: readonly HistoryEntry[] }) {
  const recent = entries.filter(entry => entry.ok && entry.kind === "query").slice(0, 40).reverse();
  if (recent.length < 2) return null;
  const max = Math.max(...recent.map(entry => entry.roundTripMs));
  return (
    <div className="flex h-16 items-end gap-0.5" aria-label="Recent query round trips">
      {recent.map(entry => (
        <div key={entry.id} title={`${formatMs(entry.roundTripMs)} round trip · ${formatMs(entry.databaseMs)} database · ${entry.label}`} className="relative flex h-full flex-1 items-end">
          <div className="w-full rounded-sm bg-kumo-line" style={{ height: `${Math.max(4, (entry.roundTripMs / max) * 100)}%` }} />
          <div className="absolute bottom-0 w-full rounded-sm bg-kumo-brand" style={{ height: `${Math.max(2, ((entry.databaseMs ?? 0) / max) * 100)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function SessionLatency({ entries, onPick }: { entries: readonly HistoryEntry[]; onPick: (entry: HistoryEntry) => void }) {
  const queries = entries.filter(entry => entry.ok && entry.kind === "query");
  const writes = entries.filter(entry => entry.ok && entry.kind === "write");
  const roundTrips = queries.map(entry => entry.roundTripMs);
  const database = queries.flatMap(entry => entry.databaseMs === undefined ? [] : [entry.databaseMs]);
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between">
        <span>Your queries</span>
        <Text variant="secondary" size="xs">{queries.length} {queries.length === 1 ? "query" : "queries"} · {writes.length} {writes.length === 1 ? "write" : "writes"}</Text>
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        {queries.length === 0 ? (
          <Text variant="secondary" size="sm">Run a query to see timings here.</Text>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-kumo-subtle"><th className="font-normal" /><th className="font-normal">p50</th><th className="font-normal">p95</th><th className="font-normal">max</th></tr></thead>
              <tbody className="font-code tabular-nums">
                <tr><td className="font-sans text-kumo-subtle">Round trip</td><td>{formatMs(percentile(roundTrips, 0.5))}</td><td>{formatMs(percentile(roundTrips, 0.95))}</td><td>{formatMs(percentile(roundTrips, 1))}</td></tr>
                <tr><td className="font-sans text-kumo-subtle">Database</td><td>{formatMs(percentile(database, 0.5))}</td><td>{formatMs(percentile(database, 0.95))}</td><td>{formatMs(percentile(database, 1))}</td></tr>
              </tbody>
            </table>
            <Sparkline entries={entries} />
            <Text variant="secondary" size="xs">Grey: round trip. Blue: database.</Text>
          </>
        )}
        <div className="flex max-h-[28rem] flex-col divide-y divide-kumo-hairline overflow-y-auto">
          {entries.map(entry => (
            <button key={entry.id} type="button" onClick={() => onPick(entry)} className="flex flex-col gap-0.5 py-2 text-left hover:bg-kumo-tint">
              <div className="flex items-center gap-2">
                <Badge variant={!entry.ok ? "error" : entry.kind === "write" ? "success" : entry.kind === "schema" ? "info" : "neutral"}>{entry.kind}</Badge>
                <span className="font-code tabular-nums text-sm text-kumo-default">{formatMs(entry.roundTripMs)}</span>
                {entry.databaseMs !== undefined && <span className="font-code tabular-nums text-xs text-kumo-subtle">db {formatMs(entry.databaseMs)}</span>}
                {entry.rows !== undefined && <span className="text-xs text-kumo-subtle">{entry.rows} rows</span>}
                <span className="ml-auto text-xs text-kumo-subtle">{entry.at.toLocaleTimeString()}</span>
              </div>
              <span className="truncate font-code text-xs text-kumo-subtle">{entry.label}</span>
            </button>
          ))}
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}
