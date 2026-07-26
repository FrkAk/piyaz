import { auth } from "@/lib/auth";
import { logTokenGrant } from "@/lib/auth/log-token-grant";
import { readBodyBounded } from "@/lib/api/read-body-bounded";
import { ensureNoStore } from "@/lib/security/headers";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const origin = new URL(baseUrl).origin;
const mcpResource = `${origin}/api/mcp`;
const grantsNeedingResource = new Set(["authorization_code", "refresh_token"]);

/**
 * Byte ceiling for a token request body.
 *
 * RFC 6749 token requests are a handful of short form fields, so this is
 * generous. The endpoint is unauthenticated, and the form branch below holds
 * three full copies of the body at once (the decoded text, the parsed params,
 * and the re-serialized string) against a 128 MB isolate shared by every
 * concurrent request, so the read is capped before any of that.
 */
const MAX_TOKEN_BODY_BYTES = 16 * 1024;

/**
 * Build the 413 returned when a token request body exceeds the cap.
 *
 * @returns An OAuth 2.0 `invalid_request` error response.
 */
function payloadTooLarge(): Response {
  return Response.json(
    { error: "invalid_request", error_description: "Request body too large" },
    { status: 413 },
  );
}

/**
 * OAuth 2.0 token endpoint wrapper that defaults the `resource` parameter
 * for MCP clients that omit it.
 *
 * Better Auth issues an opaque token when `resource` is absent and a JWT when
 * it is present. Clients such as Codex CLI do not send `resource`, so this
 * wrapper sets it to the MCP endpoint for `authorization_code` and
 * `refresh_token` grants — the flows MCP clients use. Other grants (e.g.
 * `client_credentials`) pass through untouched. Non-form requests are also
 * forwarded untouched so Better Auth handles them natively.
 *
 * Original request headers are forwarded so confidential clients using
 * HTTP Basic auth for `client_id:client_secret` continue to authenticate.
 *
 * The grant outcome (grant type, whether a refresh token was issued, and
 * the error reason on failure) is logged for diagnosability; token values
 * are never logged.
 *
 * The body is read through a byte cap before either branch, including the
 * pass-through, whose `auth.handler` performs its own unbounded read.
 *
 * Both return paths are hardened with `ensureNoStore`. Better Auth sets
 * `no-store` on a successful token response but leaves its error responses
 * header-less, so the wrapper guarantees `no-store` on every outcome and keeps
 * the directive project-owned against a future Better Auth change.
 *
 * @param request - Incoming POST to `/api/auth/oauth2/token`.
 * @returns Better Auth token response, pinned to `Cache-Control: no-store`.
 */
export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_TOKEN_BODY_BYTES) {
    return ensureNoStore(payloadTooLarge());
  }

  const raw = await readBodyBounded(request, MAX_TOKEN_BODY_BYTES);
  if (raw === null) {
    return ensureNoStore(payloadTooLarge());
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    const boundedRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: raw,
      signal: request.signal,
    });
    return ensureNoStore(await auth.handler(boundedRequest));
  }

  const body = new URLSearchParams(new TextDecoder().decode(raw));
  const grantType = body.get("grant_type") ?? "";

  if (grantsNeedingResource.has(grantType) && !body.has("resource")) {
    body.set("resource", mcpResource);
  }

  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete("content-length");

  const forwarded = new Request(request.url, {
    method: "POST",
    headers: forwardedHeaders,
    body: body.toString(),
  });

  const response = await auth.handler(forwarded);
  return ensureNoStore(
    await logTokenGrant(response, grantType, body.get("scope") ?? ""),
  );
}
