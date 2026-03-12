import type { Meta, StoryObj } from "@storybook/react-vite";

import { Card } from "./Card";

const meta = {
  title: "Primitives/Card",
  component: Card,
  args: {
    children: "Facts are durable truth. Entities are derived views.",
  },
  render: (args) => (
    <div className="w-[360px]">
      <Card {...args} />
    </div>
  ),
} satisfies Meta<typeof Card>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Accent: Story = {
  args: {
    tone: "accent",
    children: "Replayable projections let the system rebuild secondary state from the fact log.",
  },
};
