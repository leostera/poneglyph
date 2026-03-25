import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type EntityListRow = {
  namespace: string;
  kind: string;
  uri: string;
  label: string;
  lastUpdatedAt: string | null;
};

type EntityListProps = {
  rows: EntityListRow[];
  onSelect?: (row: EntityListRow) => void;
  selectedUri?: string | null;
};

export function EntityList({ rows, onSelect, selectedUri }: EntityListProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[16%]">Namespace</TableHead>
          <TableHead className="w-[16%]">Kind</TableHead>
          <TableHead className="w-[36%]">URI</TableHead>
          <TableHead className="w-[20%]">Label</TableHead>
          <TableHead>Last updated at</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            className={onSelect ? "cursor-pointer" : undefined}
            data-state={selectedUri === row.uri ? "selected" : undefined}
            key={row.uri}
            onClick={() => onSelect?.(row)}
          >
            <TableCell className="text-sm">{row.namespace}</TableCell>
            <TableCell className="text-sm">{row.kind}</TableCell>
            <TableCell className="font-mono text-xs">{row.uri}</TableCell>
            <TableCell className="text-sm">{row.label}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {row.lastUpdatedAt ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
