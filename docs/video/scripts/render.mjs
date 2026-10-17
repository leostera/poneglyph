import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode !== "voiceover" && mode !== "preview") {
  throw new Error("Usage: node scripts/render.mjs <voiceover|preview>");
}

const includeVoiceover = mode === "voiceover";
if (includeVoiceover) {
  await access(new URL("../public/voiceover.wav", import.meta.url));
}

const output = includeVoiceover
  ? "../poneglyph-explainer.mp4"
  : "../poneglyph-explainer-preview.mp4";
const args = [
  "render",
  "src/index.tsx",
  "PoneglyphExplainer",
  output,
  "--codec",
  "h264",
  "--scale",
  "0.6666666666666666",
  "--props",
  JSON.stringify({ includeVoiceover }),
];

const child = spawn("remotion", args, { stdio: "inherit" });
child.on("error", (error) => { throw error; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
