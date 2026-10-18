import {connect, constants, type ClientHttp2Session} from "node:http2";

export type ProbeReply = Readonly<{status: number; json(): Promise<unknown>}>;
export type ProbeRequest = (path: string, init?: Readonly<{method?: string; body?: string; signal?: AbortSignal}>) => Promise<ProbeReply>;

/** Node load generator only: each stream is a distinct incoming invocation. */
export async function h2Transport(origin: string, credentials: Readonly<Record<string, string>>, count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error("Invalid transport concurrency");
  const sessions: ClientHttp2Session[] = [];
  try {
    await Promise.all(Array.from({length: Math.ceil(count / 100)}, async () => {
      const session = connect(origin); sessions.push(session);
      session.on("error", () => { /* Individual requests retain their own failure. */ });
      await new Promise<void>((accept, reject) => {
        const deadline = setTimeout(() => { session.destroy(); reject(new Error("H2 session unavailable")); }, 10_000);
        session.once("remoteSettings", settings => {
          clearTimeout(deadline);
          if ((settings.maxConcurrentStreams ?? 100) < 100 && count > 1) reject(new Error("Insufficient H2 stream allocation"));
          else accept();
        });
        session.once("error", () => { clearTimeout(deadline); reject(new Error("H2 session unavailable")); });
      });
    }));
  } catch (error) { for (const session of sessions) session.destroy(); throw error; }
  let next = 0;
  const request: ProbeRequest = async (path, init = {}) => {
    if (!/^\/[a-z-]+$/.test(path)) throw new Error("Invalid benchmark path");
    const session = sessions[next++ % sessions.length]!;
    return new Promise<ProbeReply>((accept, reject) => {
      if (init.signal?.aborted) { reject(init.signal.reason); return; }
      const stream = session.request({...credentials, ":method": init.method ?? "POST", ":path": path,
        "content-type": "application/json"});
      let status = 0, size = 0, ended = false;
      const chunks: Buffer[] = [];
      const abort = () => { stream.close(constants.NGHTTP2_CANCEL); reject(init.signal?.reason ?? new Error("Cancelled")); };
      init.signal?.addEventListener("abort", abort, {once: true});
      stream.once("response", headers => { status = Number(headers[":status"]); });
      stream.on("data", (bytes: Buffer) => {
        size += bytes.length;
        if (size > 65_536) { stream.close(constants.NGHTTP2_CANCEL); reject(new Error("Reply exceeds budget")); return; }
        chunks.push(bytes);
      });
      stream.once("error", error => reject(error));
      stream.once("close", () => {
        init.signal?.removeEventListener("abort", abort);
        if (!ended) reject(new Error("H2 stream closed before complete reply"));
      });
      stream.once("end", () => {
        ended = true;
        const bytes = Buffer.concat(chunks);
        accept({status, async json() { return JSON.parse(bytes.toString("utf8")) as unknown; }});
      });
      stream.end(init.body);
    });
  };
  return {request, close() { for (const session of sessions) session.destroy(); }};
}
