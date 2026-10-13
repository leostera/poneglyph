import assert from "node:assert/strict";
import {spawn, type ChildProcess} from "node:child_process";
import {appendFileSync} from "node:fs";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {databaseControl, type LocalRuntime} from "./runtime.js";
import {ROOT} from "./build.js";
import {parseReply} from "./response-evidence.js";
import {membersOfGroup} from "./process-group.js";
import {correctnessBudgets} from "./contract.js";

type Host = {child: ChildProcess; pid: number; endpoints: readonly string[]; exited: Promise<{code: number | null; signal: NodeJS.Signals | null}>};
async function launch(graphId: string, persistence: string, token: string, bundles: string): Promise<Host> {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "process-host.ts"), JSON.stringify({graphId, persistence, token, bundles})],
    {cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"]});
  const pid = child.pid; assert.ok(pid && Number.isSafeInteger(pid) && pid > 1, "dedicated host process identity");
  const log = resolve(bundles, "native-process.log");
  child.stdout?.on("data", chunk => appendFileSync(log, chunk)); child.stderr?.on("data", chunk => appendFileSync(log, chunk));
  const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => child.once("exit", (code, signal) => resolve({code, signal})));
  try {
    const endpoints = await new Promise<readonly string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native host startup budget exceeded")), correctnessBudgets.processStartMs);
      child.once("error", error => {clearTimeout(timer); reject(error);});
      child.once("exit", () => {clearTimeout(timer); reject(new Error("native host exited before readiness"));});
      child.once("message", raw => {
        clearTimeout(timer);
        try {
          const message = parseReply(raw); assert.equal(message["type"], "ready"); assert.equal(message["pid"], pid);
          const input = message["endpoints"]; assert.ok(Array.isArray(input) && input.length === 4, "all application endpoints");
          const parsed: string[] = [];
          for (const item of input) {assert.ok(typeof item === "string"); const url = new URL(item); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.protocol, "http:"); parsed.push(url.href);}
          resolve(parsed);
        } catch (error) {reject(error);}
      });
    });
    return {child, pid, endpoints, exited};
  } catch (error) {process.kill(-pid, "SIGKILL"); await exited; throw error;}
}
async function waitExit(host: Host) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {return await Promise.race([host.exited, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("native host exit budget exceeded")), correctnessBudgets.processExitMs);})]);}
  finally {clearTimeout(timer);}
}
export type HostedRuntime = LocalRuntime & {crashAndRestart(): Promise<object>; restart(): Promise<HostedRuntime>};
export async function startHosted(graphId: string, persistence: string, bundles: string, token: string = randomUUID()): Promise<HostedRuntime> {
  let host = await launch(graphId, persistence, token, bundles), closed = false;
  const database = databaseControl(() => {
    if (closed) throw new Error("native host is closed");
    return host.endpoints[0]!;
  });
  const close = async () => {
    if (closed) return; closed = true;
    if (host.child.connected) host.child.send({type: "close"});
    try {const result = await waitExit(host); assert.equal(result.code, 0, "graceful cold restart closes its native host");}
    catch (error) {try {process.kill(-host.pid, "SIGKILL");} catch {} await host.exited; throw error;}
  };
  return {database, graphId, token, get endpoints() {return host.endpoints;}, close,
    restart: async () => {await close(); return startHosted(graphId, persistence, bundles, token);},
    crashAndRestart: async () => {
      assert.ok(!closed, "live host crash target");
      const before = membersOfGroup(host.pid);
      assert.ok(before.some(member => member.pid === host.pid), "host owns the targeted process group");
      assert.ok(before.some(member => /workerd/.test(member.command)), "actual native workerd must belong to the killed group");
      const oldPid = host.pid; process.kill(-oldPid, "SIGKILL");
      const result = await waitExit(host); assert.equal(result.signal, "SIGKILL", "abrupt termination, not disposal/exception");
      let remaining = membersOfGroup(oldPid).filter(member => !member.state.startsWith("Z"));
      for (let poll = 0; remaining.length && poll < correctnessBudgets.processDeathPolls; poll++) {
        await new Promise(resolve => setTimeout(resolve, correctnessBudgets.processDeathDelayMs)); remaining = membersOfGroup(oldPid).filter(member => !member.state.startsWith("Z"));
      }
      assert.equal(remaining.length, 0, "no running native process survives the group kill");
      host = await launch(graphId, persistence, token, bundles); assert.notEqual(host.pid, oldPid);
      return {control: "SIGKILL-process-group", killedGroup: oldPid, before, exit: result, remaining, restartedPid: host.pid, recordedAt: new Date().toISOString()};
    },
  };
}
