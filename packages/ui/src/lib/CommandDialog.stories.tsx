import type { Meta, StoryObj } from "@storybook/react-vite";

import { CommandDialog, CommandItem } from "./CommandDialog";
import { Kbd } from "./Kbd";
import { ThemeRoot } from "./ThemeRoot";

const meta = {
  title: "Overlays/CommandDialog",
  component: CommandDialog,
  args: {
    open: true,
    query: "alb",
    placeholder: "Search entities, facts, and commands",
    onOpenChange: () => undefined,
    onQueryChange: () => undefined,
  },
  render: (args) => (
    <ThemeRoot style={{ minHeight: "100vh", padding: 24 }}>
      <CommandDialog {...args}>
        <CommandItem meta="spotify:album:1xndb8d9an" title="Album: 2112" trailing={<Kbd>↵</Kbd>} />
        <CommandItem meta="Projection action" title="Replay search index" trailing={<Kbd>R</Kbd>} />
        <CommandItem
          meta="Recent fact"
          title="spotify:displayName → 2112"
          trailing={<Kbd>F</Kbd>}
        />
      </CommandDialog>
    </ThemeRoot>
  ),
} satisfies Meta<typeof CommandDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
