// Test-only fault seam. Never a deployment entrypoint or public service API.
import { GraphCoordinatorDO as CanonicalFacade } from "../../poneglyph/src/storage/coordinator-facade.js";
export { default, GraphLedgerDO, GraphTreeDO, GraphShardDO } from "../src/index.js";

export class GraphCoordinatorDO extends CanonicalFacade {
  private fault: "none" | "unavailable" | "malformed" = "none";
  private publicationFault: "none" | "blocked" | "lost" = "none";
  private admissionCalls = 0;
  private publicationCalls = 0;

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_test-cache-unavailable") { this.fault = "unavailable"; return Response.json({ok: true}); }
    if (path === "/_test-cache-malformed") { this.fault = "malformed"; return Response.json({ok: true}); }
    if (path === "/_test-cache-reset") { this.fault = "none"; return Response.json({ok: true}); }
    if (path === "/_test-write-state") return Response.json({
      admissionCalls: this.admissionCalls, publicationCalls: this.publicationCalls,
      parent: this.ctx.storage.kv.get("read-head-parent/v1") ?? null,
      head: this.ctx.storage.kv.get("read-head-state/v1") ?? null,
    });
    if (path === "/_test-publication-blocked") { this.publicationFault = "blocked"; return Response.json({ok: true}); }
    if (path === "/_test-publication-lost") { this.publicationFault = "lost"; return Response.json({ok: true}); }
    if (path === "/_test-publication-reset") { this.publicationFault = "none"; return Response.json({ok: true}); }
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
      if (this.fault === "unavailable") return Response.json({error: "fake-private-upstream-detail", retryable: true}, {status: 503});
      if (this.fault === "malformed") return Response.json({unchanged: true, snapshotSeq: 0, cut: []});
    }
    return super.fetch(request);
  }
}
