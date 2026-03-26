import type { EntityListRow } from "@/components/entities/list";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getEntity } from "@/lib/poneglyph-api";
import { useQueries } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarDays, CheckCircle2, CircleDashed } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";

type GcalEventListProps = {
  rows: EntityListRow[];
  onSelect?: (row: EntityListRow) => void;
  selectedUri?: string | null;
};

type CalendarEvent = {
  row: EntityListRow;
  title: string;
  startAt: Date | null;
  endAt: Date | null;
  status: string | null;
  calendarRef: string | null;
};

export function GcalEventList({ rows, onSelect, selectedUri }: GcalEventListProps) {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const eventRows = useMemo(
    () => rows.filter((row) => row.namespace === "gcal" && row.kind === "event"),
    [rows],
  );
  const entityQueries = useQueries({
    queries: eventRows.map((row) => ({
      queryKey: ["entity", row.uri] as const,
      queryFn: () => getEntity(row.uri),
      staleTime: 10_000,
    })),
  });

  const loading = entityQueries.some((query) => query.isLoading);

  const events = useMemo<CalendarEvent[]>(() => {
    return eventRows.map((row, index) => {
      const entity = entityQueries[index]?.data;
      const fieldValue = (suffixes: string[]) =>
        entity?.fields.find((field) => suffixes.some((suffix) => field.field.endsWith(suffix)))
          ?.value ?? null;

      const title =
        fieldValue(["schema:name", "gcal:title", "gcal:summary"]) ??
        fieldValue([":name", ":title", ":summary"]) ??
        row.label;
      const startRaw = fieldValue([":startAt", ":startedAt", ":startDateTime"]);
      const endRaw = fieldValue([":endAt", ":endedAt", ":endDateTime"]);

      return {
        row,
        title,
        startAt: parseDate(startRaw),
        endAt: parseDate(endRaw),
        status: fieldValue(["gcal:status"]) ?? fieldValue([":status"]),
        calendarRef: fieldValue([":calendar"]),
      };
    });
  }, [entityQueries, eventRows]);

  const datedEvents = useMemo(() => events.filter((event) => event.startAt), [events]);
  const eventDates = useMemo(
    () => datedEvents.map((event) => event.startAt as Date),
    [datedEvents],
  );

  const selectedDayEvents = useMemo(() => {
    if (!selectedDate) {
      return [];
    }
    return datedEvents
      .filter((event) => isSameDay(event.startAt as Date, selectedDate))
      .sort((left, right) => (left.startAt as Date).getTime() - (right.startAt as Date).getTime());
  }, [datedEvents, selectedDate]);

  useEffect(() => {
    if (datedEvents.length === 0) {
      return;
    }

    if (!selectedDate) {
      setSelectedDate(datedEvents[0]?.startAt ?? undefined);
      return;
    }

    const hasSelectedDayEvent = datedEvents.some((event) =>
      isSameDay(event.startAt as Date, selectedDate),
    );
    if (!hasSelectedDayEvent) {
      setSelectedDate(datedEvents[0]?.startAt ?? undefined);
    }
  }, [datedEvents, selectedDate]);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card className="rounded-[3px]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CalendarDays className="size-4" />
            Calendar
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <DayPicker
              mode="single"
              modifiers={{ hasEvents: eventDates }}
              modifiersClassNames={{
                hasEvents:
                  "relative after:absolute after:bottom-1 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary",
              }}
              onSelect={setSelectedDate}
              selected={selectedDate}
              showOutsideDays
            />
          )}
        </CardContent>
      </Card>

      <Card className="rounded-[3px]">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            {selectedDate ? format(selectedDate, "EEEE, MMM d, yyyy") : "Events"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {loading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : eventRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No `gcal:event` entities found.</p>
          ) : selectedDayEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events on this day.</p>
          ) : (
            selectedDayEvents.map((event) => {
              const isSelected = selectedUri === event.row.uri;
              return (
                <button
                  className="w-full rounded-[3px] border px-3 py-2 text-left hover:bg-muted/40 data-[selected=true]:bg-muted"
                  data-selected={isSelected}
                  key={event.row.uri}
                  onClick={() => onSelect?.(event.row)}
                  type="button"
                >
                  <div className="text-sm font-medium">{event.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {event.startAt ? format(event.startAt, "HH:mm") : "—"} -{" "}
                      {event.endAt ? format(event.endAt, "HH:mm") : "—"}
                    </span>
                    {event.status ? (
                      <Badge className="gap-1" variant="outline">
                        {statusToIcon(event.status)}
                        {event.status}
                      </Badge>
                    ) : null}
                    {event.calendarRef ? (
                      <Badge variant="secondary">{event.calendarRef}</Badge>
                    ) : null}
                  </div>
                </button>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function parseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function statusToIcon(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "confirmed" || normalized === "accepted") {
    return <CheckCircle2 className="size-3.5 text-emerald-600" />;
  }
  return <CircleDashed className="size-3.5 text-muted-foreground" />;
}
