import { DurableObject } from "cloudflare:workers";
import { jsonResponse, readJsonBody } from "../storage/http.js";
import { isRecord } from "../domain/result.js";

export type TodoInvalidation = Readonly<{
  type: "invalidate";
  graphId: string;
  txId: string;
  changedLists: readonly string[];
}>;

export class TodoHubDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/broadcast") return await this.receiveInvalidation(request);
    if (request.method !== "GET" || path !== "/connect") return jsonResponse({ error: "not found" }, 404);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "WebSocket upgrade required" }, 426);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async receiveInvalidation(request: Request): Promise<Response> {
    const input = await readJsonBody(request, 4_096);
    if (!input.ok || !isRecord(input.value) || input.value["type"] !== "invalidate" ||
        typeof input.value["graphId"] !== "string" || typeof input.value["txId"] !== "string" ||
        !Array.isArray(input.value["changedLists"]) ||
        !input.value["changedLists"].every((list) => typeof list === "string")) {
      return jsonResponse({ error: "invalid invalidation event" }, 400);
    }
    const result = this.broadcast(input.value as unknown as TodoInvalidation);
    return jsonResponse(result);
  }

  private broadcast(invalidation: TodoInvalidation): Readonly<{ delivered: number }> {
    const message = JSON.stringify(invalidation);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(message);
          delivered += 1;
        }
      } catch {
        try { socket.close(1011, "notification delivery failed"); } catch { /* The socket may already be closed. */ }
      }
    }
    return { delivered };
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }

  override webSocketClose(): void {}
  override webSocketError(): void {}
}
