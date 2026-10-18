// Test-only fault seam. Never a deployment entrypoint or public service API.
import { GraphCoordinatorDO as CanonicalFacade } from "../../poneglyph/src/storage/coordinator-facade.js";
export { default, GraphLedgerDO, GraphTreeDO, GraphShardDO } from "../src/index.js";

export class GraphCoordinatorDO extends CanonicalFacade {
  private fault: "none" | "unavailable" | "malformed" = "none";

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_test-cache-unavailable") { this.fault = "unavailable"; return Response.json({ok: true}); }
    if (path === "/_test-cache-malformed") { this.fault = "malformed"; return Response.json({ok: true}); }
    if (path === "/_test-cache-reset") { this.fault = "none"; return Response.json({ok: true}); }
    if (path === "/_query-read-cut") {
      if (this.fault === "unavailable") return Response.json({error: "fake-private-upstream-detail", retryable: true}, {status: 503});
      if (this.fault === "malformed") return Response.json({unchanged: true, snapshotSeq: 0, cut: []});
    }
    return super.fetch(request);
  }
}
