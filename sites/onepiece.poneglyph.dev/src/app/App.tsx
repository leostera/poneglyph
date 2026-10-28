import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Text } from "@cloudflare/kumo/components/text";
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip";
import { MoonIcon, SunIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSession, type Session } from "./api.ts";
import { ConnectPanel } from "./ConnectPanel.tsx";
import { FactsPanel } from "./FactsPanel.tsx";
import { type HistoryEntry, SessionLatency } from "./latency.tsx";
import { QueryPanel } from "./QueryPanel.tsx";
import { SchemaPanel } from "./SchemaPanel.tsx";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; session: Session };
type Tab = "query" | "facts" | "schema" | "connect";

export function App() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tab, setTab] = useState<Tab>("query");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pendingQuery, setPendingQuery] = useState<{ query: string; run: boolean; nonce: number } | undefined>();
  const nextId = useRef(1);

  useEffect(() => {
    getSession().then(session => setLoad({ state: "ready", session }), error => {
      setLoad({ state: "error", message: error instanceof Error ? error.message : "Unknown error" });
    });
  }, []);

  const record = useCallback((entry: Omit<HistoryEntry, "id" | "at">) => {
    setHistory(previous => [{ ...entry, id: nextId.current++, at: new Date() }, ...previous].slice(0, 200));
  }, []);
  const openQuery = useCallback((query: string, run: boolean) => {
    setPendingQuery({ query, run, nonce: Date.now() });
    setTab("query");
  }, []);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-kumo-canvas text-kumo-default">
        <Header />
        <main className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">
          {load.state === "loading" && <div className="flex justify-center py-24"><Loader size="lg" /></div>}
          {load.state === "error" && <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title="Couldn't load the playground" description={load.message} />}
          {load.state === "ready" && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="flex min-w-0 flex-col gap-4">
                <Tabs variant="underline" value={tab} onValueChange={value => setTab(value as Tab)} tabs={[
                  { value: "query", label: "Query" },
                  { value: "facts", label: "Add facts" },
                  { value: "schema", label: "Fields" },
                  { value: "connect", label: "Use from an agent" },
                ]} />
                <div hidden={tab !== "query"}><QueryPanel session={load.session} record={record} pending={pendingQuery} /></div>
                <div hidden={tab !== "facts"}><FactsPanel session={load.session} record={record} openQuery={openQuery} active={tab === "facts"} /></div>
                <div hidden={tab !== "schema"}><SchemaPanel record={record} openQuery={openQuery} /></div>
                <div hidden={tab !== "connect"}><ConnectPanel session={load.session} /></div>
              </div>
              <aside className="flex flex-col gap-4">
                <SessionLatency entries={history} onPick={entry => entry.kind === "query" && openQuery(entry.label, false)} />
              </aside>
            </div>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

function Header() {
  const [dark, setDark] = useState(document.documentElement.dataset.mode === "dark");
  const toggle = () => {
    const next = !dark;
    document.documentElement.dataset.mode = next ? "dark" : "light";
    localStorage.setItem("poneglyph:mode", next ? "dark" : "light");
    setDark(next);
  };
  return (
    <header className="border-b border-kumo-hairline bg-kumo-base">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
        <a href="https://poneglyph.dev" className="shrink-0" aria-label="Poneglyph"><img src="/poneglyph.svg" alt="" width={40} height={40} className="size-10" /></a>
        <div className="flex min-w-0 flex-col">
          <Text variant="heading" as="h1">One Piece playground</Text>
          <Text variant="secondary" size="xs" truncate>Query 1.5M facts from the One Piece wiki with Datalog. Built on <a className="underline" href="https://poneglyph.dev">Poneglyph</a>.</Text>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" shape="square" aria-label="Toggle dark mode" icon={dark ? <SunIcon /> : <MoonIcon />} onClick={toggle} />
        </div>
      </div>
    </header>
  );
}
