import type { EntityViewModel } from "@/components/entities/types";
import { EntityView } from "@/components/entities/view";
import { Badge } from "@/components/ui/badge";

type GmailMessageViewProps = {
  entity: EntityViewModel;
};

export function GmailMessageView({ entity }: GmailMessageViewProps) {
  const subject = findFieldValue(entity, "subject") ?? "Message";
  const from = findFieldValue(entity, "from");
  const to = findFieldValue(entity, "to");
  const receivedAt = findFieldValue(entity, "receivedAt") ?? findFieldValue(entity, "date");
  const thread = findFieldValue(entity, "threadId");

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{subject}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {from ? <Badge variant="outline">From: {from}</Badge> : null}
          {to ? <Badge variant="outline">To: {to}</Badge> : null}
          {receivedAt ? <span>Received: {receivedAt}</span> : null}
          {thread ? <span>Thread: {thread}</span> : null}
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
