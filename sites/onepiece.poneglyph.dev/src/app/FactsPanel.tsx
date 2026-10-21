import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import { CheckCircleIcon, MagnifyingGlassIcon, PaperPlaneTiltIcon, PlusIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { newRequestToken, submitFacts, Unauthenticated, type FactDraft, type Session, type WriteOutcome } from "./api.ts";
import type { HistoryEntry } from "./latency.tsx";
import { formatMs } from "./values.tsx";

type RecordEntry = (entry: Omit<HistoryEntry, "id" | "at">) => void;
type Draft = FactDraft & { key: number };

const VALUE_HINTS: Readonly<Record<string, string>> = {
  text: "Any text", number: "Signed 64-bit integer, e.g. 1500000000", boolean: "true / false",
  reference: "Entity URI, e.g. onepiece:crew:…", date: "YYYY-MM-DD", date_time: "RFC 3339, e.g. 2026-10-21T12:00:00Z",
};

function starterFacts(author: string): Draft[] {
  const entity = `playground:pirate:${author}-${Math.random().toString(36).slice(2, 7)}`;
  return [
    { key: 1, entity, field: "onepiece:name", value: { type: "text", value: "Captain Demo" }, retraction: false },
    { key: 2, entity, field: "onepiece:bounty", value: { type: "number", value: "1500000000" }, retraction: false },
    { key: 3, entity, field: "onepiece:member_of", value: { type: "reference", value: "onepiece:crew:7802a7e4-aeb6-58c5-8999-f08deccc5902" }, retraction: false },
  ];
}

function readBackQuery(facts: readonly FactDraft[]): string {
  const entity = facts[0]!.entity;
  const fields = [...new Set(facts.filter(fact => fact.entity === entity).map(fact => fact.field))];
  return fields.map((field, index) => `${field}(${JSON.stringify(entity)}, V${index + 1})`).join(", ");
}

export function FactsPanel({ session, record, onSignedOut, openQuery }: {
  session: Session; record: RecordEntry; onSignedOut: () => void; openQuery: (query: string, run: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => starterFacts(session.user.author));
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<WriteOutcome | undefined>();
  // A token is reused only to retry an unknown outcome with identical facts.
  const [token, setToken] = useState(newRequestToken);
  const [nextKey, setNextKey] = useState(10);

  const update = (key: number, change: Partial<FactDraft>) => {
    setDrafts(previous => previous.map(draft => draft.key === key ? { ...draft, ...change } : draft));
    setToken(newRequestToken());
    setOutcome(undefined);
  };
  const submit = async (requestToken: string) => {
    setSubmitting(true);
    try {
      const facts = drafts.map(({ key: _key, ...fact }) => fact);
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
          <Button size="sm" variant="ghost" onClick={() => { setDrafts(starterFacts(session.user.author)); setToken(newRequestToken()); setOutcome(undefined); }}>Reset example</Button>
        </LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          {drafts.map(draft => (
            <div key={draft.key} className="grid grid-cols-1 items-end gap-2 rounded-lg border border-kumo-hairline p-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_8.5rem_minmax(0,1.2fr)_auto]">
              <Input size="sm" label="Entity" className="font-code" value={draft.entity} spellCheck={false} onChange={event => update(draft.key, { entity: event.target.value })} />
              <Input size="sm" label="Field" className="font-code" value={draft.field} spellCheck={false} onChange={event => update(draft.key, { field: event.target.value })} />
              <Select size="sm" label="Type" value={draft.value.type}
                items={Object.fromEntries(session.writableValueTypes.map(type => [type, type]))}
                onValueChange={type => update(draft.key, { value: { type: String(type), value: type === "boolean" ? true : "" } })} />
              {draft.value.type === "boolean" ? (
                <Select size="sm" label="Value" value={String(draft.value.value)} items={{ true: "true", false: "false" }}
                  onValueChange={value => update(draft.key, { value: { type: "boolean", value: value === "true" } })} />
              ) : (
                <Input size="sm" label="Value" placeholder={VALUE_HINTS[draft.value.type]} className={draft.value.type === "text" ? "" : "font-code"}
                  value={String(draft.value.value)} spellCheck={false} onChange={event => update(draft.key, { value: { type: draft.value.type, value: event.target.value } })} />
              )}
              <div className="flex items-center gap-2 pb-1">
                <Checkbox label="Retract" checked={draft.retraction} onCheckedChange={checked => update(draft.key, { retraction: checked === true })} />
                <Button size="sm" variant="ghost" shape="square" aria-label="Remove fact" icon={<TrashIcon />} disabled={drafts.length === 1}
                  onClick={() => { setDrafts(previous => previous.filter(candidate => candidate.key !== draft.key)); setToken(newRequestToken()); }} />
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={<PlusIcon />} disabled={drafts.length >= session.limits.factsPerWrite}
              onClick={() => { const last = drafts.at(-1); setDrafts(previous => [...previous, { key: nextKey, entity: last?.entity ?? "", field: "", value: { type: "text", value: "" }, retraction: false }]); setNextKey(nextKey + 1); setToken(newRequestToken()); }}>Add fact</Button>
            <Button variant="primary" icon={<PaperPlaneTiltIcon weight="fill" />} loading={submitting} disabled={submitting} onClick={() => void submit(token)}>Commit transaction</Button>
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
