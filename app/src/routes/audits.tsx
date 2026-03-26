import { TwoColumnLayout } from "@/components/layout/two-column-layout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getAgentAuditEvents, getAgentAuditRuns } from "@/lib/poneglyph-api";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

function AuditsPage() {
  const runsQuery = useQuery({
    queryKey: ["agent-audit-runs"],
    queryFn: () => getAgentAuditRuns(100, 0),
    refetchInterval: 5_000,
  });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRunId && runsQuery.data?.length) {
      setSelectedRunId(runsQuery.data[0].id);
    }
  }, [selectedRunId, runsQuery.data]);

  const eventsQuery = useQuery({
    queryKey: ["agent-audit-events", selectedRunId],
    queryFn: () => getAgentAuditEvents(selectedRunId as string),
    enabled: selectedRunId != null,
    refetchInterval: 5_000,
  });

  const selectedRun = runsQuery.data?.find((run) => run.id === selectedRunId) ?? null;

  return (
    <TwoColumnLayout
      className="h-full px-0 pt-0"
      content={
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-l bg-background">
          <div className="border-b px-6 py-5">
            <h1 className="text-[24px] font-semibold tracking-tight">Audits</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Real runtime history for `poneglyph-agent` runs. Evals are development-only and do not
              appear here.
            </p>
          </div>

          {runsQuery.error ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertTitle>Failed to load audits</AlertTitle>
                <AlertDescription>{runsQuery.error.message}</AlertDescription>
              </Alert>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {!selectedRun ? (
              <div className="text-sm text-muted-foreground">No audit runs yet.</div>
            ) : (
              <div className="space-y-5">
                <div className="grid gap-2">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Run summary
                  </div>
                  <div className="rounded-[3px] border">
                    <dl className="grid gap-0 text-sm">
                      <SummaryRow label="Status" value={selectedRun.status} />
                      <SummaryRow label="Source" value={selectedRun.source} />
                      <SummaryRow label="Started" value={selectedRun.startedAt} />
                      <SummaryRow
                        label="Finished"
                        value={selectedRun.finishedAt ?? "Still running"}
                      />
                      <SummaryRow label="Input" value={selectedRun.inputSummary ?? "None"} />
                      <SummaryRow label="Reply" value={selectedRun.replySummary ?? "None"} />
                      <SummaryRow label="Error" value={selectedRun.errorSummary ?? "None"} />
                    </dl>
                  </div>
                </div>

                <div className="grid gap-2">
                  <div className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Timeline
                  </div>
                  {eventsQuery.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-12 w-full rounded-[3px]" />
                      <Skeleton className="h-12 w-full rounded-[3px]" />
                    </div>
                  ) : eventsQuery.error ? (
                    <Alert variant="destructive">
                      <AlertTitle>Failed to load events</AlertTitle>
                      <AlertDescription>{eventsQuery.error.message}</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="overflow-hidden rounded-[3px] border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-16">Seq</TableHead>
                            <TableHead className="w-44">Type</TableHead>
                            <TableHead className="w-48">At</TableHead>
                            <TableHead>Payload</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {eventsQuery.data?.map((event) => (
                            <TableRow key={event.id}>
                              <TableCell>{event.seq}</TableCell>
                              <TableCell className="font-medium">{event.eventType}</TableCell>
                              <TableCell>{event.occurredAt}</TableCell>
                              <TableCell>
                                <pre className="overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                                  {event.payloadJson}
                                </pre>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      }
      contentClassName="min-h-0"
      nav={
        <div className="flex h-full min-h-0 w-[340px] flex-col border-r bg-sidebar">
          <div className="border-b px-4 py-5">
            <div className="text-[13px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              Runs
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
            {runsQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full rounded-[3px]" />
                <Skeleton className="h-16 w-full rounded-[3px]" />
              </div>
            ) : runsQuery.data?.length ? (
              runsQuery.data.map((run) => (
                <button
                  className={
                    run.id === selectedRunId
                      ? "rounded-[3px] border bg-background px-3 py-3 text-left"
                      : "rounded-[3px] border border-transparent px-3 py-3 text-left hover:border-border hover:bg-background"
                  }
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{run.status}</span>
                    <span className="text-xs text-muted-foreground">{run.source}</span>
                  </div>
                  <div className="mt-1 max-h-11 overflow-hidden text-sm text-muted-foreground">
                    {run.inputSummary ?? "No input summary"}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">{run.startedAt}</div>
                </button>
              ))
            ) : (
              <div className="px-1 text-sm text-muted-foreground">No audit runs yet.</div>
            )}
          </div>
        </div>
      }
      navClassName="overflow-hidden"
    />
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] border-b px-4 py-3 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

export const Route = createFileRoute("/audits")({
  component: AuditsPage,
});
