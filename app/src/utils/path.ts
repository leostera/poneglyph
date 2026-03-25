import path from "node:path";
import { fileURLToPath } from "node:url";

export function getBasePath() {
  if (typeof import.meta !== "undefined" && import.meta.url) {
    return path.dirname(fileURLToPath(import.meta.url));
  }

  if (typeof __dirname !== "undefined") {
    return __dirname;
  }

  return process.cwd();
}
