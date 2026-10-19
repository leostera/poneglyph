import {test} from "vitest";
import assert from "node:assert/strict";
import {parseReadFaultMode, transformRead} from "./worker/read-fault.js";
const body = '{"one":1}\n{"two":2}\n';
test("read fault boundary rejects unknown modes", () => {
  assert.equal(parseReadFaultMode("record-eof"), "record-eof");
  assert.throws(() => parseReadFaultMode("invent-commit"), /unknown/); assert.throws(() => parseReadFaultMode({}), /unknown/);
});
test("no read fault preserves the original complete stream", async () => {
  const response = new Response(body); assert.equal(await transformRead(response, "none"), response); assert.equal(await response.text(), body);
});
test("empty EOF removes the entire real scan", async () => {
  assert.equal(await (await transformRead(new Response(body), "empty-eof")).text(), "");
});
test("malformed transport replaces actual scan with invalid syntax", async () => {
  assert.equal(await (await transformRead(new Response(body), "malformed")).text(), "not a JSON tuple\n");
});
test("clean EOF preserves exactly one record, not the whole chunk", async () => {
  assert.equal(await (await transformRead(new Response(body), "record-eof")).text(), '{"one":1}\n');
});
test("error occurs after a real record is delivered", async () => {
  const response = await transformRead(new Response(body), "record-error"), reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), '{"one":1}\n');
  await assert.rejects(reader.read(), /interruption/);
});
test("no record cannot silently satisfy a record-stage fault", async () => {
  await assert.rejects(transformRead(new Response(""), "record-eof"), /actual tuple/);
});
