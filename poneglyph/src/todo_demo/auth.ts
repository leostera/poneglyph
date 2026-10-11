import { jsonResponse, readJsonBody } from "../storage/http.js";
import { isRecord } from "../domain/result.js";

const SESSION_COOKIE = "poneglyph_todo";
const SESSION_TTL_SECONDS = 3_600;
const MAX_PASSPHRASE_BYTES = 256;
const encoder = new TextEncoder();

export async function handleTodoLogin(request: Request, env: Env): Promise<Response> {
  const secret = env.TODO_SHARED_PASSPHRASE;
  if (typeof secret !== "string" || secret.length === 0) {
    return jsonResponse({ error: "TODO authentication is not configured" }, 503);
  }
  const body = await readJsonBody(request, 1_024);
  if (!body.ok || !isRecord(body.value) || typeof body.value["passphrase"] !== "string") {
    return jsonResponse({ error: "expected a passphrase" }, 400);
  }
  const supplied = body.value["passphrase"];
  if (encoder.encode(supplied).byteLength > MAX_PASSPHRASE_BYTES || !(await passphraseMatches(supplied, secret))) {
    return jsonResponse({ error: "invalid passphrase" }, 401);
  }

  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS;
  const payload = `${expiresAtSeconds}:${crypto.randomUUID()}`;
  const signature = await sign(payload, secret);
  const cookieValue = `${base64Url(encoder.encode(payload))}.${base64Url(signature)}`;
  return jsonResponse({ authenticated: true, expiresAt: expiresAtSeconds }, 200, {
    "set-cookie": `${SESSION_COOKIE}=${cookieValue}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`,
  });
}

export async function hasTodoSession(request: Request, env: Env): Promise<boolean> {
  const secret = env.TODO_SHARED_PASSPHRASE;
  if (typeof secret !== "string" || secret.length === 0) return false;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookie = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (cookie === undefined) return false;
  const token = cookie.slice(SESSION_COOKIE.length + 1);
  if (token.length > 512) return false;
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (encodedPayload === undefined || encodedSignature === undefined || extra !== undefined) return false;
  try {
    const payloadBytes = fromBase64Url(encodedPayload);
    const signature = fromBase64Url(encodedSignature);
    const payload = new TextDecoder().decode(payloadBytes);
    const separator = payload.indexOf(":");
    if (separator <= 0) return false;
    const expiresAtSeconds = Number(payload.slice(0, separator));
    if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1_000)) return false;
    if (expiresAtSeconds > Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS + 30) return false;
    const key = await hmacKey(secret);
    const signatureBuffer = new ArrayBuffer(signature.byteLength);
    new Uint8Array(signatureBuffer).set(signature);
    const payloadBuffer = new ArrayBuffer(payloadBytes.byteLength);
    new Uint8Array(payloadBuffer).set(payloadBytes);
    return await crypto.subtle.verify("HMAC", key, signatureBuffer, payloadBuffer);
  } catch {
    return false;
  }
}

export function hasSameOriginWebSocket(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    const secureContext = requestUrl.protocol === "https:" ||
      (requestUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname));
    return secureContext && originUrl.origin === requestUrl.origin;
  } catch {
    return false;
  }
}

async function passphraseMatches(supplied: string, expected: string): Promise<boolean> {
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(suppliedDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function sign(payload: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid base64url token");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
