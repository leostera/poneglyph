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
        <div className="grid min-w-60 gap-3">
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
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <SectionTitle
            description="Consolidation is eventual, deterministic, and replay-safe."
            eyebrow="Entity"
            title="spotify:album:2112"
          />
        </Card>
        <Card tone="accent">
          <div className="grid gap-3">
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
