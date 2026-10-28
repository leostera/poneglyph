import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowsClockwiseIcon, LightningIcon, PlayIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DatalogEditor } from "./DatalogEditor.tsx";
import { runQuery, type QueryOutcome, type Session } from "./api.ts";
import { type HistoryEntry, QueryStats } from "./latency.tsx";
import { formatMs, ValueCell } from "./values.tsx";

const DISPLAY_ROWS = 250;
const FIELD_PATTERN = /([A-Za-z][A-Za-z0-9_.-]*:[A-Za-z0-9:_?+.-]+)\s*\(/g;
// Completion candidates: every field used by the curated examples plus fields the schema tab observed.
const KNOWN_FIELDS = ["wiki:page:title", "wiki:page:category", "wiki:page:link", "wiki:page:namespace", "wiki:page:text_bytes",
  "onepiece:name", "onepiece:alias", "onepiece:kind", "onepiece:member_of", "onepiece:former_member_of", "onepiece:captain",
  "onepiece:affiliation", "onepiece:occupation", "onepiece:ship", "onepiece:bounty", "onepiece:source_page"];
type RecordEntry = (entry: Omit<HistoryEntry, "id" | "at">) => void;

export function QueryPanel({ session, record, pending }: {
  session: Session; record: RecordEntry; pending?: { query: string; run: boolean; nonce: number };
}) {
  const [query, setQuery] = useState(session.examples[0]?.query ?? "");
  const [running, setRunning] = useState<false | "once" | "repeat">(false);
  const [outcome, setOutcome] = useState<{ query: string; result: QueryOutcome; repeat?: readonly number[] } | undefined>();
  const [selectedExample, setSelectedExample] = useState<string | undefined>(session.examples[0]?.id);

  const execute = useCallback(async (source: string, times = 1) => {
    if (!source.trim()) return;
    setRunning(times > 1 ? "repeat" : "once");
    try {
      const samples: number[] = [];
      let last: QueryOutcome | undefined;
      for (let index = 0; index < times; index++) {
        last = await runQuery(source);
        record(last.ok
          ? { kind: "query", label: source, ok: true, roundTripMs: last.roundTripMs, serverMs: last.serverMs, databaseMs: last.metrics.timing?.executionMs, rows: last.rows.length, snapshotSeq: last.snapshotSeq }
          : { kind: "query", label: source, ok: false, roundTripMs: last.roundTripMs, serverMs: last.serverMs });
        if (!last.ok) break;
        samples.push(last.roundTripMs);
      }
      if (last) setOutcome({ query: source, result: last, ...(times > 1 ? { repeat: samples } : {}) });
    } finally { setRunning(false); }
  }, [record]);

  useEffect(() => {
    if (!pending) return;
    setQuery(pending.query);
    setSelectedExample(session.examples.find(example => example.query === pending.query)?.id);
    if (pending.run) void execute(pending.query);
  }, [pending, execute, session.examples]);

  const example = session.examples.find(candidate => candidate.id === selectedExample);
  const fields = useMemo(() => [...new Set([...KNOWN_FIELDS, ...session.examples.flatMap(candidate => [...candidate.query.matchAll(FIELD_PATTERN)].map(match => match[1]!))])].sort(), [session.examples]);
  const onEdit = useCallback((value: string) => { setQuery(value); setSelectedExample(session.examples.find(candidate => candidate.query === value)?.id); }, [session.examples]);
  return (
    <div className="flex flex-col gap-4">
      <LayerCard>
        <LayerCard.Secondary>Examples</LayerCard.Secondary>
        <LayerCard.Primary>
          <div className="flex flex-wrap gap-2">
          {session.examples.map(candidate => (
            <Button key={candidate.id} size="sm" variant={candidate.id === selectedExample ? "primary" : "secondary"}
              onClick={() => { setQuery(candidate.query); setSelectedExample(candidate.id); }}>{candidate.title}</Button>
          ))}
          </div>
        </LayerCard.Primary>
      </LayerCard>

      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-2">
          <span>Datalog</span>
          <Text variant="secondary" size="xs">⌘↵ to run</Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          {example && <Text variant="secondary" size="sm">{example.description}</Text>}
          <DatalogEditor label="Datalog query" value={query} onChange={onEdit} onRun={() => void execute(query)} fields={fields} maxLength={session.limits.queryCharacters} />
          <Text variant="secondary" size="xs">
            <span className="datalog-editor font-code"><span className="dl-predicate">field</span>(<span className="dl-variable">Entity</span>, <span className="dl-variable">Value</span>)</span>
            {" "}— capitalized words are variables; reuse one to join. Ctrl+Space completes field names.
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<PlayIcon weight="fill" />} loading={running === "once"} disabled={running !== false} onClick={() => void execute(query)}>Run query</Button>
            <Button variant="secondary" icon={<ArrowsClockwiseIcon />} loading={running === "repeat"} disabled={running !== false} onClick={() => void execute(query, 5)}
              title="Runs it 5 times in a row: the first is cold, the rest warm">Run 5×</Button>
          </div>
        </LayerCard.Primary>
      </LayerCard>

      {outcome && <Result outcome={outcome} />}
    </div>
  );
}

// 408/413 are query budgets; 429 is the rate limit.
const tooBroad = (status: number) => status === 408 || status === 413;
function failureTitle(status: number, kind: "rejected" | "unavailable" | "transport"): string {
  if (kind === "transport") return "Network error";
  if (status === 429) return "Too many requests";
  if (tooBroad(status)) return "Query too broad";
  return kind === "rejected" ? "Invalid query" : "Couldn't answer";
}

function Result({ outcome }: { outcome: { query: string; result: QueryOutcome; repeat?: readonly number[] } }) {
  const { result } = outcome;
  if (!result.ok) {
    return (
      <Banner variant={result.kind === "rejected" ? "error" : "alert"} icon={result.kind === "rejected" ? <WarningCircleIcon weight="fill" /> : <WarningIcon weight="fill" />}
        title={failureTitle(result.status, result.kind)}
        description={<span>{result.error}{tooBroad(result.status) && ". Start from a specific name or move the most selective clause first."} <span className="text-kumo-subtle">({formatMs(result.roundTripMs)})</span></span>} />
    );
  }
  const columns = result.rows[0] ? Object.keys(result.rows[0]) : [];
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-2">
        <span>Result</span>
        {outcome.repeat && <Text variant="secondary" size="xs">5 runs: {outcome.repeat.map(ms => formatMs(ms)).join(" · ")}</Text>}
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        <QueryStats roundTripMs={result.roundTripMs} serverMs={result.serverMs} metrics={result.metrics} rows={result.rows.length} snapshotSeq={result.snapshotSeq} />
        {result.rows.length === 0 ? (
          <Empty size="sm" icon={<LightningIcon size={32} />} title="No matches" />
        ) : (
          <div className="max-h-[36rem] overflow-auto rounded-lg border border-kumo-hairline">
            <Table>
              <Table.Header sticky>
                <Table.Row>{columns.map(column => <Table.Head key={column}><span className="font-code">{column}</span></Table.Head>)}</Table.Row>
              </Table.Header>
              <Table.Body>
                {result.rows.slice(0, DISPLAY_ROWS).map((row, index) => (
                  <Table.Row key={index}>{columns.map(column => <Table.Cell key={column}>{row[column] ? <ValueCell value={row[column]} /> : null}</Table.Cell>)}</Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
        {result.rows.length > DISPLAY_ROWS && <Text variant="secondary" size="xs">Showing {DISPLAY_ROWS} of {result.rows.length} rows.</Text>}
      </LayerCard.Primary>
    </LayerCard>
  );
}
