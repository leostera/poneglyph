// RFD0011: how many calls per second one Durable Object serves when each call
// makes 0, 1 or 3 SQLite writes, over fetch and over RPC.
import { DurableObject } from "cloudflare:workers";

export type ProbeMode = "noop" | "write1" | "write3";

export class CeilingProbe extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  }

  hit(mode: ProbeMode, body: string): number {
    const sql = this.ctx.storage.sql;
    if (mode === "write1") sql.exec("INSERT INTO hits (body) VALUES (?)", body);
    if (mode === "write3") this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO hits (body) VALUES (?)", body);
      sql.exec("INSERT INTO counters (name, value) VALUES ('hits', 1) ON CONFLICT (name) DO UPDATE SET value = value + 1");
      sql.exec("SELECT value FROM counters WHERE name = 'hits'").toArray();
    });
    return body.length;
  }

  override async fetch(request: Request): Promise<Response> {
    const mode = new URL(request.url).pathname.slice(1) as ProbeMode;
    const body = await request.text();
    return Response.json({length: this.hit(mode, body)});
  }
}
