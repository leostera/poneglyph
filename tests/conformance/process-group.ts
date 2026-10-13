import {execFileSync} from "node:child_process";
export type ProcessMember = Readonly<{pid: number; parent: number; group: number; state: string; command: string}>;
export function parseProcessMembers(text: string): readonly ProcessMember[] {
  return text.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("malformed native process membership");
    const numbers = match.slice(1, 4).map(Number);
    if (!numbers.every(n => Number.isSafeInteger(n) && n >= 0) || numbers[0]! < 1 || numbers[2]! < 1) throw new Error("invalid native process identity");
    return Object.freeze({pid: numbers[0]!, parent: numbers[1]!, group: numbers[2]!, state: match[4]!, command: match[5]!});
  });
}
export function membersOfGroup(group: number) {
  if (!Number.isSafeInteger(group) || group < 1 || group === process.pid) throw new Error("unsafe process group target");
  return parseProcessMembers(execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="], {encoding: "utf8"})).filter(member => member.group === group);
}
