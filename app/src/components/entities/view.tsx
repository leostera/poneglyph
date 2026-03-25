import type { EntityViewModel } from "@/components/entities/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type EntityViewProps = {
  entity: EntityViewModel;
};

export function EntityView({ entity }: EntityViewProps) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="text-sm font-medium">{entity.namespace}</div>
        <div className="text-sm text-muted-foreground">{entity.kind}</div>
        <div className="font-mono text-xs text-muted-foreground">{entity.uri}</div>
      </div>

      <div className="overflow-hidden rounded-[3px] border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">Field</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entity.fields.length === 0 ? (
              <TableRow>
                <TableCell className="py-4 text-sm text-muted-foreground" colSpan={2}>
                  No fields
                </TableCell>
              </TableRow>
            ) : (
              entity.fields.map((field) => (
                <TableRow key={`${entity.uri}:${field.field}`}>
                  <TableCell className="font-mono text-xs">{field.field}</TableCell>
                  <TableCell className="font-mono text-xs">{field.value}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
