import { Badge } from "@cloudflare/kumo/components/badge";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { CodeBlock } from "@cloudflare/kumo/components/code";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Surface } from "@cloudflare/kumo/components/surface";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowRightIcon, GithubLogoIcon, MoonIcon, PlayIcon, SunIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { BENEFITS, LINKS, MCP_CONFIG, QUICKSTART, STATUS, VERSION } from "./content.ts";
import { DatalogText, HowItWorks } from "./HowItWorks.tsx";

export function App() {
  return (
    <div className="min-h-screen bg-kumo-canvas text-kumo-default">
      <Header />
      <main>
        <Hero />
        <Section id="how" title="How it works"
          description="Good for data where the connections matter: agent memory, task dependencies, knowledge maps.">
          <HowItWorks />
        </Section>
        <Section id="why" title="Why Poneglyph">
          <dl className="grid gap-x-12 gap-y-8 sm:grid-cols-2">
            {BENEFITS.map(benefit => (
              <div key={benefit.title} className="flex flex-col gap-1.5">
                <dt className="text-lg font-semibold">{benefit.title}</dt>
                <dd className="text-kumo-subtle">{benefit.body}</dd>
              </div>
            ))}
          </dl>
        </Section>
        <Section id="try" title="Try it on the One Piece wiki">
          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <Surface className="flex flex-col gap-4 rounded-xl p-6">
              <Text variant="heading2" as="h3">In your browser</Text>
              <Text variant="secondary">1.5 million facts from the One Piece wiki, plus characters, crews and ships. Run queries, see where the time goes, and add your own facts. No sign-in.</Text>
              <div><LinkButton href={LINKS.playground} variant="primary" icon={PlayIcon} external>Open the playground</LinkButton></div>
            </Surface>
            <Surface className="flex flex-col gap-4 rounded-xl p-6">
              <Text variant="heading2" as="h3">From your agent</Text>
              <Text variant="secondary">The same data over MCP. Add this to your client's config:</Text>
              <ClipboardText text={LINKS.mcp} />
              <Snippet lang="jsonc" code={MCP_CONFIG} />
            </Surface>
          </div>
        </Section>
        <Section id="run" title="Run it yourself">
          <Quickstart />
          <div className="mt-12 grid gap-6 border-t border-kumo-hairline pt-10 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <Text variant="heading3" as="h3">Status</Text>
            <div className="flex flex-col gap-4">
              <ul className="flex flex-col gap-2">
                {STATUS.map(item => (
                  <li key={item} className="flex gap-3"><span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-current opacity-40" /><Text>{item}</Text></li>
                ))}
              </ul>
              <Text variant="secondary">How it works in depth: the <a className="underline" href={LINKS.walkthrough}>walkthrough</a> and the <a className="underline" href={LINKS.rfds}>design docs</a>.</Text>
            </div>
          </div>
        </Section>
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.mode === "dark");
  const toggle = () => {
    const next = !dark;
    document.documentElement.dataset.mode = next ? "dark" : "light";
    localStorage.setItem("poneglyph:mode", next ? "dark" : "light");
    setDark(next);
  };
  return (
    <header className="sticky top-0 z-20 border-b border-kumo-hairline bg-kumo-base/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
        <a href="/" className="flex items-center gap-2.5">
          <img src="/poneglyph.svg" alt="" width={32} height={32} className="size-8" />
          <Text variant="heading3" as="span">Poneglyph</Text>
        </a>
        <nav aria-label="Sections" className="ml-6 hidden items-center gap-1 md:flex">
          {[["How it works", "#how"], ["Try it", "#try"], ["Run it", "#run"]].map(([label, href]) => (
            <LinkButton key={href} href={href} variant="ghost" size="sm">{label}</LinkButton>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <LinkButton href={LINKS.github} variant="ghost" size="sm" icon={GithubLogoIcon} external>GitHub</LinkButton>
          <Button variant="ghost" shape="square" size="sm" aria-label="Toggle dark mode" title="Toggle dark mode" icon={dark ? <SunIcon /> : <MoonIcon />} onClick={toggle} />
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-kumo-hairline">
      <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:py-28">
        <div className="flex flex-col gap-6">
          <div><Badge variant="beta">v{VERSION} · experimental</Badge></div>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">The graph database for the edge</h1>
          <p className="max-w-xl text-lg text-kumo-subtle text-pretty">Poneglyph is built on Cloudflare Workers and Durable Objects. Deploy it and go: there are no servers to run, and it grows as your data does.</p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href={LINKS.playground} variant="primary" size="lg" icon={PlayIcon} external>Try the playground</LinkButton>
            <LinkButton href="#run" variant="secondary" size="lg">Run it locally <ArrowRightIcon /></LinkButton>
          </div>
        </div>
        <HeroCard />
      </div>
    </section>
  );
}

function HeroCard() {
  return (
    <LayerCard className="min-w-0 shadow-xl">
      <LayerCard.Secondary className="px-4 py-2.5"><Text size="sm" bold>onepiece-wiki</Text></LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4 p-5">
        <pre className="font-code overflow-x-auto text-sm leading-6"><DatalogText source={`wiki:page:title(Page, "Monkey D. Luffy"),\nwiki:page:category(Page, Category)`} /></pre>
        <div className="overflow-hidden rounded-lg border border-kumo-hairline">
          <table className="w-full text-left text-sm">
            <thead className="bg-kumo-recessed text-kumo-subtle"><tr><th className="px-3 py-2 font-medium">Category</th></tr></thead>
            <tbody className="font-code">
              {["Category:Humans", "Category:Four Emperors", "Category:Super Rookies", "Category:Former Impel Down Prisoners"].map(category => (
                <tr key={category} className="border-t border-kumo-hairline"><td className="px-3 py-1.5">{category}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <Text variant="secondary" size="xs">4 of 8 rows from the live playground.</Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Quickstart() {
  const [tab, setTab] = useState("run");
  const tabs = [
    { value: "run", label: "Start it" },
    { value: "client", label: "Use it" },
    { value: "example", label: "Example" },
  ];
  const code = { run: { lang: "bash" as const, code: QUICKSTART.run }, client: { lang: "ts" as const, code: QUICKSTART.client }, example: { lang: "bash" as const, code: QUICKSTART.example } }[tab]!;
  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-3">
        <Text variant="secondary">You need <a className="underline" href="https://bun.sh">Bun 1.4.2</a> and Node.js 26. Everything runs locally; no Cloudflare account needed.</Text>
        <Text variant="secondary">The client isn't on npm yet, so use it from the repo.</Text>
        <div className="flex flex-col items-start gap-1 pt-2">
          <LinkButton href={LINKS.client} variant="ghost" size="sm" external>Client README <ArrowRightIcon /></LinkButton>
          <LinkButton href={LINKS.quickstart} variant="ghost" size="sm" external>Example code <ArrowRightIcon /></LinkButton>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="overflow-x-auto"><Tabs variant="underline" value={tab} onValueChange={value => setTab(String(value))} tabs={tabs} /></div>
        <Snippet key={tab} lang={code.lang} code={code.code} />
      </div>
    </div>
  );
}

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 border-b border-kumo-hairline">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="mb-10 flex max-w-3xl flex-col gap-3">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
          {description && <Text variant="secondary">{description}</Text>}
        </div>
        {children}
      </div>
    </section>
  );
}

function Snippet(props: React.ComponentProps<typeof CodeBlock>) {
  return <div className="min-w-0 max-w-full overflow-x-auto rounded-lg [&_pre]:w-max [&_pre]:min-w-full"><CodeBlock {...props} /></div>;
}

function Footer() {
  return (
    <footer className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 sm:flex-row sm:items-center sm:px-6">
      <div className="flex items-center gap-2">
        <img src="/poneglyph.svg" alt="" width={24} height={24} className="size-6" />
        <Text variant="secondary" size="sm">Poneglyph</Text>
      </div>
      <div className="flex flex-wrap gap-1 sm:ml-auto">
        <LinkButton href={LINKS.github} variant="ghost" size="sm" external>GitHub</LinkButton>
        <LinkButton href={LINKS.rfds} variant="ghost" size="sm" external>Design docs</LinkButton>
        <LinkButton href={LINKS.playground} variant="ghost" size="sm" external>Playground</LinkButton>
      </div>
    </footer>
  );
}
