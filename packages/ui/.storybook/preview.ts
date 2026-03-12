import type { Preview } from "@storybook/react-vite";
import "../src/styles.css";

const preview: Preview = {
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "graphite",
      values: [
        { name: "graphite", value: "#050505" },
        { name: "paper", value: "#f5f5f2" },
      ],
    },
  },
};

export default preview;
