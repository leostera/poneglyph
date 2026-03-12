import type { Meta, StoryObj } from "@storybook/react-vite";

import { StatusDot } from "./StatusDot";

const meta = {
  title: "Primitives/StatusDot",
  component: StatusDot,
  args: {
    tone: "healthy",
  },
  render: (args) => (
    <div className="flex items-center gap-4">
      <StatusDot {...args} />
      <span className="text-sm text-foreground">Status indicator</span>
    </div>
  ),
} satisfies Meta<typeof StatusDot>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Healthy: Story = {};

export const Warn: Story = {
  args: {
    tone: "warn",
  },
};

export const Offline: Story = {
  args: {
    tone: "offline",
  },
};
