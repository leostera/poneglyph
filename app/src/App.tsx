import { messages } from "@poneglyph/i18n";
import { AppShell, Badge, Button, Card, SectionTitle } from "@poneglyph/ui";

const projectionItems = [
  { name: "entity consolidator", status: "idle", detail: "Waiting for first fact batch" },
  { name: "search projection", status: "not started", detail: "Tantivy index not initialized" },
  { name: "mcp service", status: "planned", detail: "Expose local memory to agents" },
];

export function App() {
  return (
    <AppShell
      eyebrow="Poneglyph.app"
      title={messages.app.title}
      subtitle={messages.app.subtitle}
    >
      <div className="hero-grid">
        <Card>
          <SectionTitle
            title="Bootstrap the graph"
            description="This is the first clickable desktop shell. It gives us a real app window, shared UI package wiring, and a place to hang the daemon controls next."
          />
          <div className="actions">
            <Button label="Open Memory Console" />
            <Button label="Inspect Facts" tone="secondary" />
          </div>
        </Card>

        <Card tone="accent">
          <SectionTitle
            title="Architecture snapshot"
            description="Facts are the source of truth. Entities, search, and MCP all hang off the runtime we’ll wire in next."
          />
          <div className="stats">
            <div>
              <span className="stat-label">Workspace</span>
              <strong>app + packages/ui + packages/i18n</strong>
            </div>
            <div>
              <span className="stat-label">Desktop shell</span>
              <strong>Electron + React + Vite</strong>
            </div>
          </div>
        </Card>
      </div>

      <div className="content-grid">
        <Card>
          <SectionTitle
            title="Projection status"
            description="Static placeholders for now. These become live runtime health once `poneglyphd` exists."
          />
          <div className="projection-list">
            {projectionItems.map((item) => (
              <div className="projection-row" key={item.name}>
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.detail}</p>
                </div>
                <Badge>{item.status}</Badge>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle
            title="Next commits"
            description="Keep the first milestones small and shippable."
          />
          <ol className="checklist">
            <li>Wire Electron startup into a real `Poneglyph.app` shell.</li>
            <li>Add a runtime bridge API for daemon health and lifecycle.</li>
            <li>Replace placeholder cards with fact log and entity inspector views.</li>
          </ol>
        </Card>
      </div>
    </AppShell>
  );
}
