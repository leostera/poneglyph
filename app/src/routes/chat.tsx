import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { sendPoneglyphAgentMessage } from "@/lib/poneglyph-api";
import { useMutation } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { LoaderCircle, MessageSquarePlus } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  runId?: string;
};

function ChatPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Ask me about your graph, or tell me something you want me to extract into facts.",
    },
  ]);

  const sendMutation = useMutation({
    mutationFn: async (message: string) => sendPoneglyphAgentMessage(message, sessionId),
    onSuccess: (reply, message) => {
      setSessionId(reply.sessionId);
      setMessages((current) => [
        ...current,
        { role: "user", content: message },
        { role: "assistant", content: reply.reply, runId: reply.runId },
      ]);
      setDraft("");
    },
  });

  const canSend = useMemo(
    () => draft.trim().length > 0 && !sendMutation.isPending,
    [draft, sendMutation.isPending],
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) {
      return;
    }
    sendMutation.mutate(draft.trim());
  };

  return (
    <div className="flex min-h-full flex-col px-8 py-7">
      <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col gap-5">
        <header className="flex items-start justify-between gap-6">
          <div className="space-y-1.5">
            <h1 className="text-[28px] font-semibold tracking-tight">Chat</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              This is the local harness for `poneglyph-agent`. The real product path is MCP, but
              this page lets you exercise the same graph expert directly from the app.
            </p>
          </div>
          <Button
            onClick={() => {
              setSessionId(null);
              setMessages([
                {
                  role: "assistant",
                  content:
                    "New session started. Ask me about your graph, or tell me what to extract.",
                },
              ]);
            }}
            size="sm"
            variant="outline"
          >
            <MessageSquarePlus />
            New session
          </Button>
        </header>

        {sendMutation.error ? (
          <Alert variant="destructive">
            <AlertTitle>Message failed</AlertTitle>
            <AlertDescription>
              {sendMutation.error.message}{" "}
              <Link className="underline" to="/settings">
                Check Settings
              </Link>
              .
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[3px] border bg-background">
          <div className="border-b px-5 py-3 text-sm text-muted-foreground">
            {sessionId ? `Session ${sessionId}` : "No active session yet"}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {messages.map((message, index) => (
                <div
                  className={
                    message.role === "user"
                      ? "ml-auto max-w-[80%] rounded-[3px] border bg-muted px-4 py-3 text-sm leading-6"
                      : "max-w-[85%] rounded-[3px] border px-4 py-3 text-sm leading-6"
                  }
                  key={`${message.role}-${index}`}
                >
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {message.role}
                  </div>
                  <div className="whitespace-pre-wrap">{message.content}</div>
                  {message.runId ? (
                    <div className="mt-3 text-xs text-muted-foreground">
                      Audit run {message.runId}
                    </div>
                  ) : null}
                </div>
              ))}
              {sendMutation.isPending ? (
                <div className="max-w-[85%] rounded-[3px] border px-4 py-3 text-sm text-muted-foreground">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    assistant
                  </div>
                  <div className="flex items-center gap-2">
                    <LoaderCircle className="size-4 animate-spin" />
                    Thinking...
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <form className="border-t px-5 py-4" onSubmit={submit}>
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              <textarea
                className="min-h-28 w-full rounded-[3px] border bg-background px-3 py-2 text-sm outline-none focus:border-foreground"
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask about schema, search the graph, or tell poneglyph-agent to extract facts."
                value={draft}
              />
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  The same built-in agent is exposed to other agents over MCP.
                </div>
                <Button disabled={!canSend} size="sm" type="submit">
                  {sendMutation.isPending ? <LoaderCircle className="animate-spin" /> : null}
                  Send
                </Button>
              </div>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});
