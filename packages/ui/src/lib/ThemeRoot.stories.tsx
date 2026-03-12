import type { Meta, StoryObj } from "@storybook/react-vite";

import { Badge } from "./Badge";
import { Card } from "./Card";
import { ThemeRoot } from "./ThemeRoot";

const meta = {
  title: "Foundation/ThemeRoot",
  component: ThemeRoot,
  parameters: {
    layout: "fullscreen",
  },
  render: () => (
    <ThemeRoot style={{ minHeight: "100vh", padding: 24 }}>
      <Card>
        <div style={{ display: "grid", gap: 12 }}>
          <Badge tone="accent">dense interface</Badge>
          <p style={{ margin: 0 }}>
            The theme root carries tokens for surface contrast, typography, and accent states.
          </p>
        </div>
      </Card>
    </ThemeRoot>
  ),
} satisfies Meta<typeof ThemeRoot>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
