import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { MagnifyingGlassIcon, TreeStructureIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { getSchema, type SchemaOutcome } from "./api.ts";
import type { HistoryEntry } from "./latency.tsx";
import { formatMs } from "./values.tsx";

type RecordEntry = (entry: Omit<HistoryEntry, "id" | "at">) => void;

export function SchemaPanel({ record, openQuery }: { record: RecordEntry; openQuery: (query: string, run: boolean) => void }) {
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<SchemaOutcome | undefined>();
  const observe = async () => {
    setLoading(true);
    try {
      const result = await getSchema();
      setOutcome(result);
      record({ kind: "schema", label: "get_schema", ok: result.ok, roundTripMs: result.roundTripMs, ...(result.ok ? { serverMs: result.serverMs, snapshotSeq: result.snapshotSeq, rows: result.fields.length } : {}) });
    } finally { setLoading(false); }
  };
  return (
    <div className="flex flex-col gap-4">
      <LayerCard>
        <LayerCard.Secondary>Fields in use</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Text variant="secondary" size="sm">Poneglyph has no fixed schema; any name can be a field. This lists the fields that currently hold data, and their value types.</Text>
          <div><Button variant="primary" icon={<TreeStructureIcon />} loading={loading} onClick={() => void observe()}>List fields</Button></div>
        </LayerCard.Primary>
      </LayerCard>
      {outcome && !outcome.ok && <Banner variant="alert" icon={<WarningIcon weight="fill" />} title="Couldn't list fields" description={outcome.error} />}
      {outcome?.ok && (
        <LayerCard>
          <LayerCard.Secondary className="flex flex-wrap items-center gap-2">
            <span>{outcome.fields.length} fields</span>
            {outcome.snapshotSeq !== undefined && <Badge variant="neutral">snapshot {outcome.snapshotSeq}</Badge>}
            <Badge variant="outline">round trip {formatMs(outcome.roundTripMs)}</Badge>
          </LayerCard.Secondary>
          <LayerCard.Primary className="p-0">
            <Table>
              <Table.Header><Table.Row><Table.Head>Field</Table.Head><Table.Head>Value types</Table.Head><Table.Head /></Table.Row></Table.Header>
              <Table.Body>
                {outcome.fields.map(field => (
                  <Table.Row key={field.field}>
                    <Table.Cell><span className="font-code text-sm">{field.field}</span></Table.Cell>
                    <Table.Cell><div className="flex flex-wrap gap-1">{field.valueTags.map(tag => <Badge key={tag} variant="outline">{tag}</Badge>)}</div></Table.Cell>
                    <Table.Cell><Button size="xs" variant="ghost" icon={<MagnifyingGlassIcon />}
                      onClick={() => openQuery(`${field.field}(Entity, Value)`, false)}>Query</Button></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard.Primary>
        </LayerCard>
      )}
    </div>
  );
}
