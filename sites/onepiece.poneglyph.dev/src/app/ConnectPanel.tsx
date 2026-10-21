import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import type { Session } from "./api.ts";

export function ConnectPanel({ session }: { session: Session }) {
  const config = JSON.stringify({ mcpServers: { "poneglyph-onepiece": { type: "http", url: session.mcp.url } } }, null, 2);
  return (
    <div className="flex flex-col gap-4">
      <LayerCard>
        <LayerCard.Secondary>Query from your agent (MCP)</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Text variant="secondary" size="sm">The same graph is exposed as a read-only MCP server with three tools: describe_dataset, get_schema and query. It is behind the same Cloudflare Access policy, so your MCP transport must authenticate (for example through cloudflared access).</Text>
          <div className="flex flex-col gap-1"><Text variant="secondary" size="xs">Server URL</Text><ClipboardText text={session.mcp.url} /></div>
          <div className="flex flex-col gap-1">
            <Text variant="secondary" size="xs">Client configuration</Text>
            <pre className="overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-recessed p-3 font-code text-xs">{config}</pre>
          </div>
          <div className="flex flex-col gap-1">
            <Text variant="secondary" size="xs">Prompt to paste into your agent</Text>
            <pre className="whitespace-pre-wrap rounded-lg border border-kumo-hairline bg-kumo-recessed p-3 text-sm">{session.mcp.instructions}</pre>
          </div>
        </LayerCard.Primary>
      </LayerCard>
      <LayerCard>
        <LayerCard.Secondary>About this dataset</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Text size="sm">{session.dataset.note}</Text>
          <Text variant="secondary" size="sm">{session.dataset.entityIdentity}</Text>
          <Text variant="secondary" size="sm">{session.dataset.queryLanguage}</Text>
          <ul className="list-disc space-y-1 pl-5 text-sm text-kumo-subtle">{session.dataset.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}
