import {startLocal} from "./runtime.js";
import {parseReply} from "./response-evidence.js";
const input = parseReply(JSON.parse(process.argv[2] ?? "null"));
for (const key of ["graphId", "persistence", "token", "bundles"]) if (typeof input[key] !== "string" || !input[key]) throw new Error(`invalid host ${key}`);
const graphId = String(input["graphId"]), persistence = String(input["persistence"]), token = String(input["token"]), bundles = String(input["bundles"]);
const runtime = await startLocal(graphId, persistence, 4, token, bundles);
if (!process.send || !process.disconnect) {await runtime.close(); throw new Error("native host requires an owned IPC channel");}
process.send({type: "ready", pid: process.pid, endpoints: runtime.endpoints});
let shutdown: Promise<void> | undefined;
const close = () => shutdown ??= runtime.close();
// A lost supervisor must not leave a detached local matrix running. SIGKILL
// fixtures terminate this entire group abruptly and cannot run this cleanup.
process.once("disconnect", () => {void close().catch(error => {console.error(error); process.exitCode = 1;});});
process.on("message", async input => {
  if (!input || typeof input !== "object" || Reflect.get(input, "type") !== "close") return;
  await close(); process.disconnect?.();
});
