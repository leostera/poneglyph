import type { Meta, StoryObj } from "@storybook/react-vite";

import { TextInput } from "./TextInput";

const meta = {
  title: "Forms/TextInput",
  component: TextInput,
  args: {
    defaultValue: "spotify:album:1xndb8d9an",
    placeholder: "Search entities, fields, and facts",
  },
  render: (args) => (
    <div className="w-80">
      <TextInput {...args} />
    </div>
  ),
} satisfies Meta<typeof TextInput>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    defaultValue: undefined,
  },
};
