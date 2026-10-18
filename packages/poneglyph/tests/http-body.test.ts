import {describe, expect, it} from "vitest";
import {readJsonBody} from "../src/storage/http.js";

const request = (body: string) => new Request("https://request.test", {method: "POST", body});

describe("bounded JSON body ownership", () => {
  it("releases the reader after parsing a complete body", async () => {
    const input = request('{"value":1}');
    expect(await readJsonBody(input, 100)).toEqual({ok: true, value: {value: 1}});
    expect(input.body?.locked).toBe(false);
  });

  it("releases the reader when JSON is malformed", async () => {
    const input = request("{");
    expect(await readJsonBody(input, 100)).toEqual({ok: false, error: {path: "body", message: "request body must be valid JSON"}});
    expect(input.body?.locked).toBe(false);
  });

  it("cancels an oversized UTF-8 body and releases its reader", async () => {
    const input = request('"海"');
    expect(await readJsonBody(input, 4)).toEqual({ok: false, error: {path: "body", message: "request body exceeds the 4-byte limit"}});
    expect(input.body?.locked).toBe(false);
  });

  it("releases an errored stream without exposing its error", async () => {
    const body = new ReadableStream<Uint8Array>({start(controller) {controller.error(new Error("private producer detail"));}});
    // Node's Request requires duplex for stream bodies; Workers ignore it.
    const init = {method: "POST", body, duplex: "half"};
    const input = new Request("https://request.test", init);
    expect(await readJsonBody(input, 100)).toEqual({ok: false, error: {path: "body", message: "could not read the request body"}});
    expect(input.body?.locked).toBe(false);
  });
});
