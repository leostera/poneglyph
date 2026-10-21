import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { InputArea } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowsClockwiseIcon, LightningIcon, PlayIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { runQuery, Unauthenticated, type QueryOutcome, type Session } from "./api.ts";
import { type HistoryEntry, QueryStats } from "./latency.tsx";
import { formatMs, ValueCell } from "./values.tsx";

const DISPLAY_ROWS = 250;
type RecordEntry = (entry: Omit<HistoryEntry, "id" | "at">) => void;

export function QueryPanel({ session, record, onSignedOut, pending }: {
  session: Session; record: RecordEntry; onSignedOut: () => void; pending?: { query: string; run: boolean; nonce: number };
}) {
  const [query, setQuery] = useState(session.examples[1]?.query ?? "");
  const [running, setRunning] = useState<false | "once" | "repeat">(false);
  const [outcome, setOutcome] = useState<{ query: string; result: QueryOutcome; repeat?: readonly number[] } | undefined>();
  const [selectedExample, setSelectedExample] = useState<string | undefined>(session.examples[1]?.id);

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
    } catch (error) {
      if (error instanceof Unauthenticated) onSignedOut();
    } finally { setRunning(false); }
  }, [record, onSignedOut]);

  useEffect(() => {
    if (!pending) return;
    setQuery(pending.query);
    setSelectedExample(session.examples.find(example => example.query === pending.query)?.id);
    if (pending.run) void execute(pending.query);
  }, [pending, execute, session.examples]);

  const example = session.examples.find(candidate => candidate.id === selectedExample);
  return (
    <div className="flex flex-col gap-4">
      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-2">
          <span>Examples</span>
          <Text variant="secondary" size="xs">Click one, then run it. Clauses are joined left to right.</Text>
        </LayerCard.Secondary>
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
          <Text variant="secondary" size="xs">⌘/Ctrl + Enter to run</Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          {example && <Text variant="secondary" size="sm">{example.description}</Text>}
          <InputArea aria-label="Datalog query" className="font-code text-sm" autoResize minRows={3} maxRows={12} value={query}
            spellCheck={false} maxLength={session.limits.queryCharacters}
            onValueChange={value => { setQuery(value); setSelectedExample(session.examples.find(candidate => candidate.query === value)?.id); }}
            onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void execute(query); } }} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<PlayIcon weight="fill" />} loading={running === "once"} disabled={running !== false} onClick={() => void execute(query)}>Run query</Button>
            <Button variant="secondary" icon={<ArrowsClockwiseIcon />} loading={running === "repeat"} disabled={running !== false} onClick={() => void execute(query, 5)}>Run 5×</Button>
            <Text variant="secondary" size="xs">Run 5× issues sequential requests to compare cold and warm latency.</Text>
          </div>
        </LayerCard.Primary>
      </LayerCard>

      {outcome && <Result outcome={outcome} />}
    </div>
  );
}

function Result({ outcome }: { outcome: { query: string; result: QueryOutcome; repeat?: readonly number[] } }) {
  const { result } = outcome;
  if (!result.ok) {
    return (
      <Banner variant={result.kind === "rejected" ? "error" : "alert"} icon={result.kind === "rejected" ? <WarningCircleIcon weight="fill" /> : <WarningIcon weight="fill" />}
        title={result.kind === "rejected" ? "Query rejected" : "No complete answer"}
        description={<span>{result.error} <span className="text-kumo-subtle">({formatMs(result.roundTripMs)})</span></span>} />
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
          <Empty size="sm" icon={<LightningIcon size={32} />} title="No rows" description="The query completed: no facts match at this snapshot. That is a complete answer, not a timeout." />
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
        {result.rows.length > DISPLAY_ROWS && <Text variant="secondary" size="xs">Showing the first {DISPLAY_ROWS} of {result.rows.length} rows. The database returned the complete bag.</Text>}
      </LayerCard.Primary>
    </LayerCard>
  );
}
