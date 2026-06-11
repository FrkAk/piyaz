import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONWebKeySet } from "jose";
import { z } from "zod/v4";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { auth } from "@/lib/auth";
import { createMcpServer } from "@/lib/mcp/create-server";
import { classifyVerifyError, hasKid } from "@/lib/mcp/verify";
import { makeAuthContext, type AuthContext } from "@/lib/auth/context";
import { parseEnvInt } from "@/lib/config/env";
import { readBodyBounded } from "@/lib/api/read-body-bounded";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const origin = new URL(baseUrl).origin;
const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;
const audiences: [string, string] = [origin, `${origin}/api/mcp`];
const issuer = `${baseUrl}/api/auth`;

/**
 * Maximum accepted MCP JSON-RPC request body, in bytes. The Next.js server-
 * action `bodySizeLimit` does NOT apply to this route handler, so without an
 * explicit cap a token holder could POST a multi-megabyte body that persists
 * to the DB and is then re-served verbatim into every teammate's agent
 * context (storage + egress amplification). 1 MB comfortably fits the largest
 * legitimate payload — a full unabridged implementation plan is tens of KB —
 * while bounding worst-case cost. Tunable via MCP_MAX_BODY_BYTES; an explicit
 * 0 is honored as a hard freeze (every request body rejected) and logged at
 * module init so a typo'd env var is not a silent outage.
 */
const MAX_MCP_BODY_BYTES = parseEnvInt(
  process.env.MCP_MAX_BODY_BYTES,
  1_000_000,
);
if (MAX_MCP_BODY_BYTES === 0) {
  console.warn(
    "MCP_MAX_BODY_BYTES=0: every MCP request body will be rejected with 413.",
  );
}

/**
 * Build a JSON-RPC error envelope response.
 * @param code - JSON-RPC error code.
 * @param message - Human-readable error message.
 * @param status - HTTP status code.
 * @param headers - Optional extra response headers.
 * @returns JSON-RPC error response.
 */
function jsonRpcError(
  code: number,
  message: string,
  status: number,
  headers?: HeadersInit,
) {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers },
  );
}

/**
 * MCP-spec 413 response for an over-limit request body.
 * @returns 413 JSON-RPC error response.
 */
function payloadTooLarge() {
  return jsonRpcError(-32600, "Request body too large.", 413);
}

/** Shape we require from a verified MCP access token payload. */
const accessTokenClaimsSchema = z.looseObject({
  sub: z.uuid(),
});

/**
 * Resolve the active JSON Web Key Set in-process via the JWT plugin's API
 * surface. Worker self-fetches against `/api/auth/jwks` traverse the
 * Cloudflare edge stack (per `wrangler.jsonc`'s `global_fetch_strictly_public`
 * compatibility flag) and can be rejected by upstream filtering, which leaves
 * Better-Auth's per-isolate JWKS cache (`@better-auth/core/dist/oauth2/verify.mjs:7`)
 * populated with `undefined` for the lifetime of the isolate. `auth.api.*` is
 * target-agnostic so self-host shares the same path.
 *
 * @returns The active JWK set with the signing key.
 * @throws Error when `auth.api.getJwks()` returns an unexpected shape.
 */
async function fetchJwksInProcess(): Promise<JSONWebKeySet> {
  const result = await auth.api.getJwks();
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as { keys?: unknown }).keys)
  ) {
    throw new Error("auth.api.getJwks returned unexpected shape");
  }
  return result as JSONWebKeySet;
}

/**
 * Verify a JWT Bearer token from the Authorization header. Uses
 * `verifyJwsAccessToken` (local-only verify) so `jwksFetch` can take a
 * function — `verifyAccessToken` types its `jwksUrl` as `string` and would
 * reject the in-process callback. No introspection (`remoteVerify`).
 *
 * Returns `null` for token-class failures (signature, expiry, audience,
 * issuer, malformed JWT) so the caller maps to 401. Re-throws everything
 * else (JWKS fetch failures, shape drift, downstream DB errors) so the
 * platform returns 5xx — a 401 on infrastructure failure would push valid
 * clients into a re-auth loop that also fails.
 *
 * @param request - Incoming request.
 * @returns JWT payload if valid, null on token-class failures.
 * @throws Error for non-token failures (JWKS unreachable, shape drift,
 *   downstream errors); not caught here so the route returns 5xx.
 */
async function verifyMcpAuth(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  if (!token) return null;

  // Short-circuit malformed / kid-less tokens here so better-auth's
  // string-matched "Missing jwt kid" path is never reached.
  if (!hasKid(token)) {
    console.warn(
      JSON.stringify({
        event: "mcp_auth_verify_failed",
        reason: "missing_or_invalid_kid",
      }),
    );
    return null;
  }

  try {
    return await verifyJwsAccessToken(token, {
      jwksFetch: fetchJwksInProcess,
      verifyOptions: { audience: audiences, issuer },
    });
  } catch (err) {
    const classification = classifyVerifyError(err);
    const code =
      err instanceof Error
        ? (err as Error & { code?: unknown }).code
        : undefined;

    console.warn(
      JSON.stringify({
        event:
          classification === "token"
            ? "mcp_auth_verify_failed"
            : "mcp_auth_verify_error",
        name: err instanceof Error ? err.name : undefined,
        code: typeof code === "string" ? code : undefined,
        // Do NOT log `err.cause` — `JWTClaimValidationFailed` stores the
        // decoded JWT payload there.
        message: err instanceof Error ? err.message : String(err),
      }),
    );

    if (classification === "infrastructure") throw err;
    return null;
  }
}

/**
 * Resolve the MCP auth context from a verified JWT payload. Requires only
 * `sub` (user id); team scope is resolved per call in the data layer via
 * membership JOINs, never via a token-bound active-org claim.
 *
 * @param payload - Decoded JWT payload.
 * @returns AuthContext or null when the subject claim is missing.
 */
function authContextFromPayload(payload: unknown): AuthContext | null {
  const parsed = accessTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) return null;
  return makeAuthContext(parsed.data.sub);
}

/**
 * MCP-spec 401 response with WWW-Authenticate header pointing to
 * the protected resource metadata URL (RFC 9728).
 * @returns 401 JSON-RPC error response.
 */
function unauthorized() {
  return jsonRpcError(-32000, "Unauthorized", 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
    "Access-Control-Expose-Headers": "WWW-Authenticate",
  });
}

/**
 * POST handler for MCP JSON-RPC messages via Streamable HTTP transport.
 * Requires a valid JWT Bearer token (subject claim only).
 * @param request - Incoming MCP JSON-RPC request.
 * @returns MCP JSON-RPC response or 401.
 */
export async function POST(request: Request) {
  const payload = await verifyMcpAuth(request);
  if (!payload) return unauthorized();

  const ctx = authContextFromPayload(payload);
  if (!ctx) return unauthorized();

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_BODY_BYTES) {
    return payloadTooLarge();
  }
  const body = await readBodyBounded(request, MAX_MCP_BODY_BYTES);
  if (body === null) {
    return payloadTooLarge();
  }
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });

  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(boundedRequest);
}

/**
 * GET handler. The transport's GET path opens a long-lived SSE notification
 * stream — useful only in stateful mode where the server may push
 * server-initiated notifications. This route runs stateless
 * (`sessionIdGenerator: undefined`), so the stream has nothing to send and an
 * open `ReadableStream` would sit until the Workers 30s wall-time cancels the
 * request. Returning 405 + `Allow: POST, DELETE` lets compliant clients
 * downgrade to the POST-only flow per MCP Streamable HTTP §3.
 *
 * @returns 405 Method Not Allowed.
 */
export function GET() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
    {
      status: 405,
      headers: {
        Allow: "POST, DELETE",
        "Content-Type": "application/json",
      },
    },
  );
}

/**
 * DELETE handler for MCP session termination.
 * No-op in stateless mode.
 * @returns 204 No Content.
 */
export function DELETE() {
  return new Response(null, { status: 204 });
}
