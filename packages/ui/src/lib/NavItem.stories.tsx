import type { Meta, StoryObj } from "@storybook/react-vite";

import { NavItem } from "./NavItem";
import { StatusDot } from "./StatusDot";

const meta = {
  title: "Navigation/NavItem",
  component: NavItem,
  args: {
    children: "Entities",
    meta: "124",
  },
  render: (args) => (
    <div className="w-60">
      <NavItem {...args} />
    </div>
  ),
} satisfies Meta<typeof NavItem>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = {
  args: {
    active: true,
    meta: <StatusDot tone="healthy" />,
  },
};
