import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const saved = localStorage.getItem("poneglyph:mode");
if (saved === "dark" || (saved === null && matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.dataset.mode = "dark";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
