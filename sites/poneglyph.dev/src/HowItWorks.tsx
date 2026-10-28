import { Button } from "@cloudflare/kumo/components/button";
import { CodeBlock } from "@cloudflare/kumo/components/code";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Text } from "@cloudflare/kumo/components/text";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { HOW } from "./content.ts";

type StepId = (typeof HOW)[number]["id"];
const BRAND = "#f6821f";

export function HowItWorks() {
  const [index, setIndex] = useState(0);
  const step = HOW[index]!;
  return (
    <LayerCard>
      <LayerCard.Secondary className="px-4 py-2">
        <div className="max-w-full overflow-x-auto">
          <Tabs variant="segmented" value={step.id} onValueChange={value => setIndex(HOW.findIndex(item => item.id === value))}
            tabs={HOW.map((item, position) => ({ value: item.id, label: `${position + 1}. ${item.label}` }))} />
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-8 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Graph step={step.id} />
        <div className="flex min-w-0 flex-col gap-4" aria-live="polite">
          <Text variant="heading2" as="h3">{step.title}</Text>
          <Text variant="secondary">{step.body}</Text>
          {"code" in step && <Snippet lang="ts" code={step.code} />}
          {"query" in step && (
            <>
              <pre className="font-code overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-recessed p-4 text-sm leading-6"><DatalogText source={step.query} /></pre>
              <Snippet lang="ts" code={step.result} />
            </>
          )}
          {index < HOW.length - 1 && (
            <div className="mt-auto pt-2"><Button variant="secondary" size="sm" onClick={() => setIndex(index + 1)}>Next: {HOW[index + 1]!.label} <ArrowRightIcon /></Button></div>
          )}
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}

// One small graph: a service blocked by a task, the task's status and owner.
// Step 2 numbers each edge with the fact that creates it; step 3 highlights
// the path the query matches and names the variables bound to each node.
const NODES = [
  { id: "service", x: 90, y: 70, kind: "service", name: "auth-api", variable: "Service", labelAt: [90, 26] },
  { id: "task", x: 330, y: 70, kind: "task", name: "rotate-key", variable: "Task", labelAt: [330, 26] },
  { id: "person", x: 330, y: 250, kind: "person", name: "ari", variable: "Owner", labelAt: [330, 290] },
] as const;
const EDGES = [
  { from: [150, 70], to: [270, 70], label: "blocked-by", fact: 1, labelAt: [210, 58] },
  { from: [295, 92], to: [140, 226], label: "status", fact: 2, labelAt: [205, 150] },
  { from: [330, 92], to: [330, 226], label: "owner", fact: 3, labelAt: [350, 160] },
] as const;

function Graph({ step }: { step: StepId }) {
  const highlight = step === "query";
  return (
    <svg viewBox="0 0 440 310" className="h-auto w-full max-w-md justify-self-center text-kumo-default" role="img" aria-label="A service blocked by a task, which is open and owned by a person">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
      </defs>
      {EDGES.map(edge => (
        <g key={edge.label}>
          <line x1={edge.from[0]} y1={edge.from[1]} x2={edge.to[0]} y2={edge.to[1]} markerEnd="url(#arrow)"
            stroke={highlight ? BRAND : "currentColor"} strokeOpacity={highlight ? 1 : 0.45} strokeWidth={highlight ? 2.5 : 1.5} className="transition-all duration-300" />
          <text x={edge.labelAt[0]} y={edge.labelAt[1]} textAnchor={edge.label === "owner" ? "start" : "middle"} className="font-code" fontSize="12" fill="currentColor" fillOpacity={0.75}>{edge.label}</text>
          {step === "write" && (
            <g>
              <circle cx={edge.labelAt[0] + (edge.label === "owner" ? 60 : edge.label === "status" ? -38 : 52)} cy={edge.labelAt[1] - 4} r="10" fill={BRAND} />
              <text x={edge.labelAt[0] + (edge.label === "owner" ? 60 : edge.label === "status" ? -38 : 52)} y={edge.labelAt[1]} textAnchor="middle" fontSize="12" fontWeight="600" fill="white">{edge.fact}</text>
            </g>
          )}
        </g>
      ))}
      {NODES.map(node => (
        <g key={node.id}>
          <rect x={node.x - 60} y={node.y - 22} width="120" height="44" rx="10" fill="var(--color-kumo-base, white)"
            stroke={highlight ? BRAND : "currentColor"} strokeOpacity={highlight ? 1 : 0.35} strokeWidth={highlight ? 2 : 1.25} className="transition-all duration-300" />
          <text x={node.x} y={node.y - 4} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity={0.6}>{node.kind}</text>
          <text x={node.x} y={node.y + 12} textAnchor="middle" fontSize="13" fontWeight="600" className="font-code" fill="currentColor">{node.name}</text>
          {highlight && <text x={node.labelAt[0]} y={node.labelAt[1]} textAnchor="middle" fontSize="12" className="font-code dl-variable" fill="currentColor">{node.variable}</text>}
        </g>
      ))}
      {/* A plain value, not an entity. */}
      <rect x="50" y="228" width="80" height="44" rx="22" fill="none" stroke={highlight ? BRAND : "currentColor"} strokeOpacity={highlight ? 1 : 0.35} strokeDasharray="4 3" />
      <text x="90" y="255" textAnchor="middle" fontSize="13" className="font-code dl-string" fill="currentColor">"open"</text>
    </svg>
  );
}

function Snippet(props: React.ComponentProps<typeof CodeBlock>) {
  return <div className="min-w-0 max-w-full overflow-x-auto rounded-lg [&_pre]:w-max [&_pre]:min-w-full"><CodeBlock {...props} /></div>;
}

export function DatalogText({ source }: { source: string }) {
  const parts = source.split(/("(?:[^"\\]|\\.)*"|[A-Z][A-Za-z0-9_]*|[a-z][\w-]*(?::[\w-]+)+(?=\())/g);
  return <>{parts.map((part, index) => {
    if (part.startsWith('"')) return <span key={index} className="dl-string">{part}</span>;
    if (/^[A-Z]/.test(part)) return <span key={index} className="dl-variable">{part}</span>;
    if (/^[a-z][\w-]*:/.test(part)) return <span key={index} className="dl-predicate">{part}</span>;
    return <span key={index}>{part}</span>;
  })}</>;
}
