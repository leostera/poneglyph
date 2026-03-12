import type { Preview } from "@storybook/react-vite";
import "../src/styles.css";

const preview: Preview = {
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "graphite",
      values: [
        { name: "graphite", value: "#110e0c" },
        { name: "paper", value: "#f5efe2" },
      ],
    },
  },
};

export default preview;
