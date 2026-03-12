import type { Meta, StoryObj } from "@storybook/react-vite";

import { Kbd } from "./Kbd";

const meta = {
  title: "Primitives/Kbd",
  component: Kbd,
  args: {
    children: "⌘K",
  },
} satisfies Meta<typeof Kbd>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ShortKey: Story = {
  args: {
    children: "Esc",
  },
};
