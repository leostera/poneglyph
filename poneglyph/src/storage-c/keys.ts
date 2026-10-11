import { ROUTING_VERSION } from "./constants.js";
import { parseGraphId } from "../domain/graph-id.js";
import { parsed, rejected, type ParseResult } from "../domain/result.js";

const PREFIX_BRAND: unique symbol = Symbol("VirtualPrefix");
const KEY_BRAND: unique symbol = Symbol("VirtualKey");

export type VirtualPrefix = string & Readonly<{ [PREFIX_BRAND]: true }>;
export type VirtualKey = string & Readonly<{ [KEY_BRAND]: true }>;

export const ROOT_PREFIX = "" as VirtualPrefix;

export function parseVirtualPrefix(input: unknown): ParseResult<VirtualPrefix> {
  if (typeof input !== "string" || input.length > 256 || !/^[01]*$/.test(input)) {
    return rejected("prefix", "expected a 0/1 prefix no deeper than 256 bits");
  }
  return parsed(input as VirtualPrefix);
}

export function parseVirtualKey(input: unknown): ParseResult<VirtualKey> {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input)) {
    return rejected("virtualKey", "expected a 256-bit lowercase hexadecimal key");
  }
  return parsed(input as VirtualKey);
}

export async function virtualKeyForEntity(graphId: string, entity: string): Promise<VirtualKey> {
  const graph = parseGraphId(graphId);
  if (!graph.ok) throw new TypeError("cannot route an invalid graph ID");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${graph.value}\u0000${entity}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return hex as VirtualKey;
}

export function bitAt(key: VirtualKey, depth: number): "0" | "1" {
  if (!Number.isInteger(depth) || depth < 0 || depth >= 256) {
    throw new RangeError("virtual-key bit depth must be in 0..255");
  }
  const nibble = Number.parseInt(key[Math.floor(depth / 4)] ?? "0", 16);
  return (nibble & (1 << (3 - (depth % 4)))) === 0 ? "0" : "1";
}

export function prefixOfKey(key: VirtualKey, depth: number): VirtualPrefix {
  if (!Number.isInteger(depth) || depth < 0 || depth > 256) {
    throw new RangeError("virtual-key prefix depth must be in 0..256");
  }
  let prefix = "";
  for (let bit = 0; bit < depth; bit += 1) prefix += bitAt(key, bit);
  return prefix as VirtualPrefix;
}

export function matchesPrefix(key: VirtualKey, prefix: VirtualPrefix): boolean {
  return prefixOfKey(key, prefix.length) === prefix;
}

export function childPrefix(prefix: VirtualPrefix, bit: "0" | "1"): VirtualPrefix {
  if (prefix.length >= 256) throw new RangeError("a full-depth virtual-key prefix cannot be split");
  return `${prefix}${bit}` as VirtualPrefix;
}

export function shardObjectName(graphId: string, prefix: VirtualPrefix = ROOT_PREFIX): string {
  const graph = parseGraphId(graphId);
  if (!graph.ok) throw new TypeError("cannot name a shard for an invalid graph ID");
  const token = prefix === ROOT_PREFIX ? "root" : `${prefix.length.toString(16)}-${packPrefix(prefix)}`;
  return `graph:${graph.value}:node:v${ROUTING_VERSION}:${token}`;
}

export function coordinatorObjectName(graphId: string): string {
  const graph = parseGraphId(graphId);
  if (!graph.ok) throw new TypeError("cannot name a coordinator for an invalid graph ID");
  return `graph:${graph.value}:coordinator:v${ROUTING_VERSION}`;
}

function packPrefix(prefix: VirtualPrefix): string {
  let packed = "";
  for (let offset = 0; offset < prefix.length; offset += 4) {
    const bits = prefix.slice(offset, offset + 4).padEnd(4, "0");
    packed += Number.parseInt(bits, 2).toString(16);
  }
  return packed;
}
