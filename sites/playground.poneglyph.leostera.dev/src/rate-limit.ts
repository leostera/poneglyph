// This numeric namespace must be checked for account collisions before deploy.
// Cloudflare counters are approximate and per location, not a global spend cap.
export const RATE_LIMIT = { namespace: "2026101401", simple: { limit: 30, period: 60 as const } };

export async function admitMcpRequest(request: Request, limiter: Pick<RateLimit, "limit"> | undefined): Promise<Response | undefined> {
  if (limiter === undefined) return limiterUnavailable();
  // Cloudflare sets this on public ingress. Never key on caller-controlled
  // X-Forwarded-For, tool arguments, cookies or arbitrary client IDs. Missing
  // edge metadata (including local dev) shares one bucket, not an exemption.
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  const key = ip && ip.length <= 64 ? `mcp:ip:${ip}` : "mcp:unknown-client";
  try {
    const { success } = await limiter.limit({ key });
    if (success) return undefined;
    return Response.json({ error: "MCP rate limit exceeded. Wait before sending another request." }, {
      status: 429, headers: { "retry-after": String(RATE_LIMIT.simple.period), "cache-control": "no-store" },
    });
  } catch {
    console.error(JSON.stringify({ event: "playground-rate-limiter-unavailable" }));
    return limiterUnavailable();
  }
}

function limiterUnavailable(): Response {
  // Public queries fail closed; an unavailable limiter never means unlimited.
  return Response.json({ error: "MCP admission is temporarily unavailable." }, {
    status: 503, headers: { "retry-after": "60", "cache-control": "no-store" },
  });
}
