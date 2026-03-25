import type { EntityViewModel } from "@/components/entities/types";
import { EntityView } from "@/components/entities/view";
import { Badge } from "@/components/ui/badge";

type GcalEventViewProps = {
  entity: EntityViewModel;
};

export function GcalEventView({ entity }: GcalEventViewProps) {
  const title = findFieldValue(entity, "title") ?? findFieldValue(entity, "summary") ?? "Event";
  const startsAt = findFieldValue(entity, "startedAt") ?? findFieldValue(entity, "startDateTime");
  const endsAt = findFieldValue(entity, "endedAt") ?? findFieldValue(entity, "endDateTime");
  const calendar = findFieldValue(entity, "calendar");
  const location = findFieldValue(entity, "location");

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {calendar ? <Badge variant="outline">{calendar}</Badge> : null}
          {startsAt ? <span>Starts: {startsAt}</span> : null}
          {endsAt ? <span>Ends: {endsAt}</span> : null}
          {location ? <span>Location: {location}</span> : null}
        </div>
      </div>

      <EntityView entity={entity} />
    </div>
  );
}

function findFieldValue(entity: EntityViewModel, fieldSuffix: string): string | null {
  const match = entity.fields.find((field) => field.field.endsWith(`:${fieldSuffix}`));
  return match?.value ?? null;
}
