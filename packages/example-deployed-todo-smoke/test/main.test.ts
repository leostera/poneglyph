import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { main, nextMessage, type Socket } from "../src/main.ts";

function socket(): Socket & EventEmitter {
  return Object.assign(new EventEmitter(), { close() {}, terminate() {} });
}

test("TODO invalidation decoding accepts UTF-8 object messages", async () => {
  const client = socket(), pending = nextMessage(client);
  const event = { type: "invalidate", graphId: "todo-shared-2026", txId: "test:move", commitSeq: 7 };
  client.emit("message", Buffer.from(JSON.stringify(event)));
  assert.deepEqual(await pending, event);
});

test("TODO invalidation decoding rejects malformed JSON and non-object frames", async () => {
  for (const frame of ["{", "null", "[]", "1"]) {
    const client = socket(), pending = nextMessage(client);
    client.emit("message", frame);
    await assert.rejects(pending);
  }
});

test("missing target or secret rejects before any cloud request", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  await assert.rejects(main({}), /explicitly approved/);
  await assert.rejects(main({ PONEGLYPH_CLOUDFLARE_URL: "https://approved.poneglyph.leostera.dev" }), /PASSPHRASE/);
  assert.equal(network.mock.callCount(), 0);
});

test("built TODO smoke imports without opening a cloud request or socket", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  const entry = await import(new URL("../dist/main.js", import.meta.url).href);
  assert.equal(typeof entry.main, "function");
  assert.equal(network.mock.callCount(), 0);
});
