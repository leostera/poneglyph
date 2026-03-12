import type { Meta, StoryObj } from "@storybook/react-vite";

import { AppShell } from "./AppShell";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { NavItem } from "./NavItem";
import { SectionTitle } from "./SectionTitle";
import { StatusDot } from "./StatusDot";

const meta = {
  title: "Shell/AppShell",
  component: AppShell,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    eyebrow: "Workspace",
    title: "Poneglyph.",
    subtitle: "Facts are durable truth. Entities, search, and projections stay replayable.",
  },
  render: (args) => (
    <AppShell
      {...args}
      sidebar={
        <div style={{ display: "grid", gap: 12, minWidth: 240 }}>
          <SectionTitle
            description="Primary views for operating the local graph."
            eyebrow="Workspace"
            title="Navigation"
          />
          <NavItem active meta={<StatusDot tone="healthy" />}>
            Entities
          </NavItem>
          <NavItem meta="Lag 12">Facts</NavItem>
        </div>
      }
    >
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <Card>
          <SectionTitle
            description="Consolidation is eventual, deterministic, and replay-safe."
            eyebrow="Entity"
            title="spotify:album:2112"
          />
        </Card>
        <Card tone="accent">
          <div style={{ display: "grid", gap: 12 }}>
            <Badge tone="accent">Projection healthy</Badge>
            <Button label="Open inspector" />
          </div>
        </Card>
      </div>
    </AppShell>
  ),
} satisfies Meta<typeof AppShell>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
