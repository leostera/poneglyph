import type { EntityViewModel } from "@/components/entities/types";
import { EntityView } from "@/components/entities/view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";
import { CalendarClock, CheckCircle2, CircleDashed, Link as LinkIcon, MapPin } from "lucide-react";

type GcalEventViewProps = {
  entity: EntityViewModel;
};

export function GcalEventView({ entity }: GcalEventViewProps) {
  const title =
    findField(entity, ["schema:name", "gcal:title", "gcal:summary"]) ??
    findFieldValue(entity, "title") ??
    findFieldValue(entity, "summary") ??
    "Event";
  const startsAtRaw =
    findFieldValue(entity, "startAt") ??
    findFieldValue(entity, "startedAt") ??
    findFieldValue(entity, "startDateTime");
  const endsAtRaw =
    findFieldValue(entity, "endAt") ??
    findFieldValue(entity, "endedAt") ??
    findFieldValue(entity, "endDateTime");
  const calendar = findFieldValue(entity, "calendar");
  const location = findFieldValue(entity, "location");
  const status = findField(entity, ["gcal:status"]) ?? findFieldValue(entity, "status");
  const htmlLink = findFieldValue(entity, "htmlLink");
  const description =
    findField(entity, ["gcal:description"]) ?? findFieldValue(entity, "description");
  const startsAt = formatDateTime(startsAtRaw);
  const endsAt = formatDateTime(endsAtRaw);

  return (
    <div className="space-y-3">
      <Card className="rounded-[3px]">
        <CardHeader className="pb-3">
          <CardTitle className="text-xl font-semibold tracking-tight">{title}</CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {status ? (
              <Badge className="gap-1" variant="outline">
                {statusToIcon(status)}
                {status}
              </Badge>
            ) : null}
            {calendar ? <Badge variant="secondary">{calendar}</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div className="space-y-1 text-sm">
            {(startsAt || endsAt) && (
              <div className="flex items-center gap-2">
                <CalendarClock className="size-4 text-muted-foreground" />
                <span>
                  {startsAt ?? "—"} {endsAt ? `→ ${endsAt}` : ""}
                </span>
              </div>
            )}
            {location ? (
              <div className="flex items-center gap-2">
                <MapPin className="size-4 text-muted-foreground" />
                <span>{location}</span>
              </div>
            ) : null}
            {htmlLink ? (
              <a
                className="inline-flex items-center gap-2 text-sm text-primary underline-offset-2 hover:underline"
                href={htmlLink}
                rel="noreferrer"
                target="_blank"
              >
                <LinkIcon className="size-4" />
                Open in Google Calendar
              </a>
            ) : null}
          </div>
          {description ? (
            <p className="rounded-[3px] border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-1">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Raw Entity
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

function findField(entity: EntityViewModel, fieldUris: string[]): string | null {
  for (const uri of fieldUris) {
    const match = entity.fields.find((field) => field.field === uri);
    if (match?.value) {
      return match.value;
    }
  }
  return null;
}

function formatDateTime(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return format(parsed, "EEE, MMM d, yyyy HH:mm");
}

function statusToIcon(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "confirmed" || normalized === "accepted") {
    return <CheckCircle2 className="size-3.5 text-emerald-600" />;
  }
  return <CircleDashed className="size-3.5 text-muted-foreground" />;
}
