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
    <ThemeRoot className="min-h-screen p-6">
      <Card>
        <div className="grid gap-3">
          <Badge tone="accent">dense interface</Badge>
          <p className="m-0 text-sm leading-6 text-muted-foreground">
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
