import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { CheckCircleIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { getSchema, newRequestToken, submitFacts, type FactDraft, type Session, type WriteOutcome } from "./api.ts";
import type { EditorProblems } from "./FactsEditor.tsx";
import { observedRelationFields, parseFactsSource, starterSource } from "./facts-source.ts";
import type { HistoryEntry } from "./latency.tsx";
import { formatMs } from "./values.tsx";

type RecordEntry = (entry: Omit<HistoryEntry, "id" | "at">) => void;
const FactsEditor = lazy(() => import("./FactsEditor.tsx"));

function readBackQuery(facts: readonly FactDraft[]): string {
  const entity = facts[0]!.entity;
  const fields = [...new Set(facts.filter(fact => fact.entity === entity).map(fact => fact.field))];
  return fields.map((field, index) => `${field}(${JSON.stringify(entity)}, V${index + 1})`).join(", ");
}

export function FactsPanel({ session, record, openQuery, active }: {
  session: Session; record: RecordEntry; openQuery: (query: string, run: boolean) => void; active: boolean;
}) {
  const [source, setSource] = useState(() => starterSource(session.user.author));
  const [reset, setReset] = useState(() => ({ text: source, nonce: 0 }));
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | undefined>();
  const [problems, setProblems] = useState<EditorProblems>({ errors: 0 });
  const [relationFields, setRelationFields] = useState<string[]>([]);
  const schemaLoaded = useRef(false);
  // A token is reused only to retry an unknown outcome with identical facts.
  const [token, setToken] = useState(newRequestToken);
  const parsed = useMemo(() => parseFactsSource(source, session.limits.factsPerWrite), [source, session.limits.factsPerWrite]);

  useEffect(() => {
    if (!active || schemaLoaded.current) return;
    let mounted = true;
    void getSchema().then(result => {
      if (mounted && result.ok) {
        setRelationFields(observedRelationFields(result.fields));
        schemaLoaded.current = true;
      }
    }).catch(() => undefined); // Suggestions are optional.
    return () => { mounted = false; };
  }, [active]);

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
    } finally { setSubmitting(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <Banner variant="secondary" title="Add facts to the live graph"
        description={`Everyone sees what you add. A batch of up to ${session.limits.factsPerWrite} facts is saved all at once or not at all. Nothing is edited in place: to undo a fact, add it again with retract: true.`} />
      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-2">
          <span>Transaction</span>
          <Button size="sm" variant="ghost" onClick={() => { const text = starterSource(session.user.author); setReset(previous => ({ text, nonce: previous.nonce + 1 })); edit(text); }}>Reset</Button>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Suspense fallback={<div className="flex h-[22rem] items-center justify-center rounded-lg border border-kumo-line"><Loader /></div>}>
            <FactsEditor reset={reset} relationFields={relationFields} onChange={edit} onCommit={() => { if (parsed.ok && !submitting) void submit(token); }} onProblems={setProblems} />
          </Suspense>
          <div className="flex flex-wrap items-center gap-2">
                        <Button variant="primary" icon={<PaperPlaneTiltIcon weight="fill" />} loading={submitting} disabled={submitting || !parsed.ok} onClick={() => void submit(token)}>Save facts</Button>
            {parsed.ok ? (
              <Text variant="secondary" size="xs">
                {parsed.facts.length} {parsed.facts.length === 1 ? "fact" : "facts"} · {((count) => `${count} ${count === 1 ? "entity" : "entities"}`)(new Set(parsed.facts.map(fact => fact.entity)).size)}
                {parsed.facts.some(fact => fact.retraction) ? ` · ${parsed.facts.filter(fact => fact.retraction).length} retractions` : ""} · ⌘↵ to save · Ctrl+Space suggests fields that link to other entities
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
          <LayerCard.Secondary className="flex items-center gap-2"><CheckCircleIcon weight="fill" className="text-kumo-success" /> Saved</LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">{outcome.facts.length} facts</Badge>
              <Badge variant="neutral">round trip {formatMs(outcome.roundTripMs)}</Badge>
              <Badge variant="outline">worker {formatMs(outcome.serverMs)}</Badge>
            </div>
            <div className="flex flex-col gap-1"><Text variant="secondary" size="xs">Transaction ID</Text><ClipboardText text={outcome.txId} /></div>
            <Text variant="secondary" size="sm">Your facts are live; the next query will see them.</Text>
            <div><Button variant="primary" icon={<MagnifyingGlassIcon />} onClick={() => openQuery(readBackQuery(outcome.facts), true)}>Query it</Button></div>
          </LayerCard.Primary>
        </LayerCard>
      )}
      {outcome && !outcome.ok && (
        <Banner variant={outcome.delivery === "unknown" ? "alert" : "error"} icon={<WarningIcon weight="fill" />}
          title={outcome.delivery === "unknown" ? "Didn't hear back" : "Not saved"}
          description={outcome.error}
          action={outcome.delivery === "unknown" ? <Banner.Action onClick={() => void submit(token)}>Retry</Banner.Action> : undefined} />
      )}
    </div>
  );
}
