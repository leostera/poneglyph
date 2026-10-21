import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { CheckCircleIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { lazy, Suspense, useMemo, useState } from "react";
import { newRequestToken, submitFacts, Unauthenticated, type FactDraft, type Session, type WriteOutcome } from "./api.ts";
import type { EditorProblems } from "./FactsEditor.tsx";
import { parseFactsSource, starterSource } from "./facts-source.ts";
import type { HistoryEntry } from "./latency.tsx";
import { formatMs } from "./values.tsx";

type RecordEntry = (entry: Omit<HistoryEntry, "id" | "at">) => void;
const FactsEditor = lazy(() => import("./FactsEditor.tsx"));

function readBackQuery(facts: readonly FactDraft[]): string {
  const entity = facts[0]!.entity;
  const fields = [...new Set(facts.filter(fact => fact.entity === entity).map(fact => fact.field))];
  return fields.map((field, index) => `${field}(${JSON.stringify(entity)}, V${index + 1})`).join(", ");
}

export function FactsPanel({ session, record, onSignedOut, openQuery }: {
  session: Session; record: RecordEntry; onSignedOut: () => void; openQuery: (query: string, run: boolean) => void;
}) {
  const [source, setSource] = useState(() => starterSource(session.user.author));
  const [reset, setReset] = useState(() => ({ text: source, nonce: 0 }));
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | undefined>();
  const [problems, setProblems] = useState<EditorProblems>({ errors: 0 });
  // A token is reused only to retry an unknown outcome with identical facts.
  const [token, setToken] = useState(newRequestToken);
  const parsed = useMemo(() => parseFactsSource(source, session.limits.factsPerWrite), [source, session.limits.factsPerWrite]);

  const edit = (value: string) => { setSource(value); setToken(newRequestToken()); setOutcome(undefined); };
  const submit = async (requestToken: string) => {
    setSubmitting(true);
    try {
      if (!parsed.ok) return;
      const facts = parsed.facts;
      const result = await submitFacts(facts, requestToken);
      setOutcome(result);
      record({ kind: "write", label: `${facts.length} fact${facts.length === 1 ? "" : "s"} · ${facts[0]?.entity ?? ""}`, ok: result.ok, roundTripMs: result.roundTripMs, ...(result.ok ? { serverMs: result.serverMs } : {}) });
      if (result.ok || result.delivery !== "unknown") setToken(newRequestToken());
    } catch (error) {
      if (error instanceof Unauthenticated) onSignedOut();
    } finally { setSubmitting(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <Banner variant="secondary" title="Append facts to the live graph"
        description={`Writes are atomic transactions appended to ${session.graphId}. Nothing is overwritten: a retraction is a new fact that hides an earlier one. Your facts are attributed to author ${session.user.author} (a hash, not your email). Up to ${session.limits.factsPerWrite} facts per transaction.`} />
      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-2">
          <span>Transaction</span>
          <Button size="sm" variant="ghost" onClick={() => { const text = starterSource(session.user.author); setReset(previous => ({ text, nonce: previous.nonce + 1 })); edit(text); }}>Reset example</Button>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Suspense fallback={<div className="flex h-[22rem] items-center justify-center rounded-lg border border-kumo-line"><Loader /></div>}>
            <FactsEditor reset={reset} onChange={edit} onCommit={() => { if (parsed.ok && !submitting) void submit(token); }} onProblems={setProblems} />
          </Suspense>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<PaperPlaneTiltIcon weight="fill" />} loading={submitting} disabled={submitting || !parsed.ok} onClick={() => void submit(token)}>Commit transaction</Button>
            {parsed.ok ? (
              <Text variant="secondary" size="xs">
                {parsed.facts.length} {parsed.facts.length === 1 ? "fact" : "facts"} · {((count) => `${count} ${count === 1 ? "entity" : "entities"}`)(new Set(parsed.facts.map(fact => fact.entity)).size)}
                {parsed.facts.some(fact => fact.retraction) ? ` · ${parsed.facts.filter(fact => fact.retraction).length} retractions` : ""} · ⌘/Ctrl+Enter commits
              </Text>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-kumo-danger"><WarningCircleIcon weight="fill" />{parsed.error}</span>
            )}
            {parsed.ok && problems.errors > 0 && <span className="inline-flex items-center gap-1 text-xs text-kumo-warning" title={problems.first}><WarningIcon weight="fill" />{problems.errors} type {problems.errors === 1 ? "issue" : "issues"}: {problems.first}</span>}
          </div>
        </LayerCard.Primary>
      </LayerCard>
      {outcome?.ok && (
        <LayerCard>
          <LayerCard.Secondary className="flex items-center gap-2"><CheckCircleIcon weight="fill" className="text-kumo-success" /> Committed</LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">{outcome.facts.length} facts</Badge>
              <Badge variant="neutral">round trip {formatMs(outcome.roundTripMs)}</Badge>
              <Badge variant="outline">worker {formatMs(outcome.serverMs)}</Badge>
            </div>
            <div className="flex flex-col gap-1"><Text variant="secondary" size="xs">Transaction ID</Text><ClipboardText text={outcome.txId} /></div>
            <Text variant="secondary" size="sm">The receipt is returned only after every participant shard applied the transaction and the read snapshot advanced, so the next query sees it.</Text>
            <div><Button variant="primary" icon={<MagnifyingGlassIcon />} onClick={() => openQuery(readBackQuery(outcome.facts), true)}>Read it back</Button></div>
          </LayerCard.Primary>
        </LayerCard>
      )}
      {outcome && !outcome.ok && (
        <Banner variant={outcome.delivery === "unknown" ? "alert" : "error"} icon={<WarningIcon weight="fill" />}
          title={outcome.delivery === "unknown" ? "Outcome unknown" : "Transaction rejected; nothing was written"}
          description={outcome.error}
          action={outcome.delivery === "unknown" ? <Banner.Action onClick={() => void submit(token)}>Retry safely</Banner.Action> : undefined} />
      )}
    </div>
  );
}
