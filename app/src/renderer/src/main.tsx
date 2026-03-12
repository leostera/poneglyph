import React from "react";
import { createRoot } from "react-dom/client";
import "@poneglyph/ui/styles.css";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing root container");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
