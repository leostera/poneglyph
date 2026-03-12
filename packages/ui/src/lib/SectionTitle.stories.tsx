import type { Meta, StoryObj } from "@storybook/react-vite";

import { SectionTitle } from "./SectionTitle";

const meta = {
  title: "Primitives/SectionTitle",
  component: SectionTitle,
  args: {
    eyebrow: "Entity",
    title: "spotify:album:1xndb8d9an",
    description: "The current consolidated view for this entity and the facts that shaped it.",
  },
  render: (args) => (
    <div style={{ width: 360 }}>
      <SectionTitle {...args} />
    </div>
  ),
} satisfies Meta<typeof SectionTitle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
