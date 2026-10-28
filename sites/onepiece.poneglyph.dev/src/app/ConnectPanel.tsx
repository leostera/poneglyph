import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import type { Session } from "./api.ts";

export function ConnectPanel({ session }: { session: Session }) {
  const config = JSON.stringify({ mcpServers: { "poneglyph-onepiece": { type: "http", url: session.mcp.url } } }, null, 2);
  return (
    <div className="flex flex-col gap-4">
      <LayerCard>
        <LayerCard.Secondary>Connect over MCP</LayerCard.Secondary>
        <LayerCard.Primary className="flex flex-col gap-3">
          <Text variant="secondary" size="sm">Point any MCP client at this URL. No sign-in. Tools: <code className="font-code">describe_dataset</code>, <code className="font-code">get_schema</code>, <code className="font-code">query</code> (read-only).</Text>
          <div className="flex flex-col gap-1"><Text variant="secondary" size="xs">Server URL</Text><ClipboardText text={session.mcp.url} /></div>
          <div className="flex flex-col gap-1">
            <Text variant="secondary" size="xs">Client configuration</Text>
            <pre className="overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-recessed p-3 font-code text-xs">{config}</pre>
          </div>
          <div className="flex flex-col gap-1">
            <Text variant="secondary" size="xs">Starter prompt</Text>
            <pre className="whitespace-pre-wrap rounded-lg border border-kumo-hairline bg-kumo-recessed p-3 text-sm">{session.mcp.instructions}</pre>
          </div>
        </LayerCard.Primary>
      </LayerCard>
      <LayerCard>
        <LayerCard.Secondary>About this dataset</LayerCard.Secondary>
        <LayerCard.Primary>
          <dl className="flex flex-col gap-3 text-sm">
            {session.about.map(item => (
              <div key={item.title}><dt className="font-medium">{item.title}</dt><dd className="text-kumo-subtle">{item.body}</dd></div>
            ))}
          </dl>
        </LayerCard.Primary>
      </LayerCard>
    </div>
  );
}
