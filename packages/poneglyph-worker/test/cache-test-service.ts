// Test-only fault seam. Never a deployment entrypoint or public service API.
import { GraphCoordinatorDO as CanonicalFacade } from "../../poneglyph/src/storage/coordinator-facade.js";
export { default, GraphLedgerDO, GraphTreeDO, GraphShardDO } from "../src/index.js";

export class GraphCoordinatorDO extends CanonicalFacade {
  private fault: "none" | "unavailable" | "malformed" = "none";
  private publicationFault: "none" | "blocked" | "lost" = "none";
  private admissionCalls = 0;
  private publicationCalls = 0;
  private readCutCalls = 0;
  private discoveryCalls = 0;
  private validationCalls = 0;
  private headFault: "none" | "unavailable" | "malformed" = "none";
  private commandFault: "none" | "freeze" | "activate" = "none";

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_test-cache-unavailable") { this.fault = "unavailable"; return Response.json({ok: true}); }
    if (path === "/_test-cache-malformed") { this.fault = "malformed"; return Response.json({ok: true}); }
    if (path === "/_test-cache-reset") { this.fault = "none"; return Response.json({ok: true}); }
    if (path === "/_test-write-state") return Response.json({
      admissionCalls: this.admissionCalls, publicationCalls: this.publicationCalls,
      readCutCalls: this.readCutCalls, discoveryCalls: this.discoveryCalls, validationCalls: this.validationCalls,
      parent: this.ctx.storage.kv.get("read-head-parent/v1") ?? null,
      head: this.ctx.storage.kv.get("read-head-state/v1") ?? null,
    });
    if (path === "/_test-publication-blocked") { this.publicationFault = "blocked"; return Response.json({ok: true}); }
    if (path === "/_test-publication-lost") { this.publicationFault = "lost"; return Response.json({ok: true}); }
    if (path === "/_test-publication-reset") { this.publicationFault = "none"; return Response.json({ok: true}); }
    if (path === "/_test-head-unavailable") { this.headFault = "unavailable"; return Response.json({ok: true}); }
    if (path === "/_test-head-malformed") { this.headFault = "malformed"; return Response.json({ok: true}); }
    if (path === "/_test-head-block-freeze") { this.commandFault = "freeze"; return Response.json({ok: true}); }
    if (path === "/_test-head-block-activate") { this.commandFault = "activate"; return Response.json({ok: true}); }
    if (path === "/_test-head-reset") { this.headFault = "none"; this.commandFault = "none"; return Response.json({ok: true}); }
    if (path === "/_read-head-discover") this.discoveryCalls++;
    if (path === "/_read-head-validate") {
      this.validationCalls++;
      if (this.headFault === "unavailable") return Response.json({error: "fake-private-head-detail"}, {status: 503});
      if (this.headFault === "malformed") return Response.json({unchanged: true, snapshotSeq: -1});
    }
    if (path === "/_read-head-command" && this.commandFault !== "none") {
      const raw = await request.clone().json<{command?: {kind?: string}}>();
      if (raw.command?.kind === this.commandFault) {
        if (this.commandFault === "freeze") { const response = await super.fetch(request); await response.arrayBuffer(); }
        return Response.json({error: "fake-private-head-command-detail"}, {status: 503});
      }
    }
    if (path === "/_test-head-pump") { await this.alarm(); return Response.json({ok: true}); }
    if (request.method === "POST" && path.endsWith("/transactions")) {
      this.admissionCalls++;
      return Response.json({error: "RPC admission must not visit the facade"}, {status: 503});
    }
    if (request.method === "POST" && path === "/_publish-vector") {
      this.publicationCalls++;
      if (this.publicationFault === "blocked") return Response.json({error: "fake-private-publication-detail"}, {status: 503});
      const response = await super.fetch(request);
      if (this.publicationFault === "lost" && response.ok) {
        this.publicationFault = "none";
        await response.arrayBuffer();
        return Response.json({error: "fake-private-publication-detail"}, {status: 503});
      }
      return response;
    }
    if (path === "/_query-read-cut") {
      this.readCutCalls++;
      if (this.fault === "unavailable") return Response.json({error: "fake-private-upstream-detail", retryable: true}, {status: 503});
      if (this.fault === "malformed") return Response.json({unchanged: true, snapshotSeq: 0, cut: []});
    }
    return super.fetch(request);
  }
}
