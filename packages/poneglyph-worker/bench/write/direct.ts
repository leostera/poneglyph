import {resolve} from "node:path";
import {startPrivatePreview as startPreview} from "../private-preview.js";
import type {settings} from "./model.js";

export async function startPrivatePreview(options: {
  here: string; artifact: string; scope: ReturnType<typeof settings>; port: number;
  environment: NodeJS.ProcessEnv; auditOnly?: boolean; suffix?: string;
}) {
  const {here, scope} = options;
  return startPreview({role: "write", artifact: options.artifact, port: options.port, environment: options.environment,
    concurrency: options.auditOnly ? 1 : scope.count, suffix: options.suffix ?? "direct", configuration: {
      main: resolve(here, "operator.ts"), compatibility_date: "2026-10-18", compatibility_flags: ["nodejs_compat"],
      durable_objects: {bindings: [
        {name: "GRAPH_FACADES", class_name: "GraphCoordinatorDO", script_name: "poneglyph-mavplus-validation-worker"},
        {name: "GRAPH_LEDGERS", class_name: "GraphLedgerDO", script_name: "poneglyph-mavplus-validation-worker"},
      ]}, vars: {RUN_ID: scope.runId, CASE: scope.kind, COUNT: scope.count, AUDIT_ONLY: options.auditOnly === true},
    }});
}
