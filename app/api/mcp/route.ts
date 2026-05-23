import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONWebKeySet } from "jose";
import { z } from "zod/v4";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { auth } from "@/lib/auth";
import { createMcpServer } from "@/lib/mcp/create-server";
import { makeAuthContext, type AuthContext } from "@/lib/auth/context";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const origin = new URL(baseUrl).origin;
const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;
const audiences: [string, string] = [origin, `${origin}/api/mcp`];
const issuer = `${baseUrl}/api/auth`;

/**
 * jose error `code`s that mean the bearer token itself is bad. Anything else
 * thrown from the verify path is treated as infrastructure failure (JWKS
 * fetch error, DB outage, shape drift) and re-thrown so the caller returns
 * a 5xx instead of a 401 — clients must not be told to re-authenticate when
 * the actual problem is the server side.
 *
 * `err.code` is a stable string literal on every jose error
 * (`node_modules/jose/dist/webapi/util/errors.js`); `err.name` would be the
 * class identifier, which webpack minifies in production builds and so
 * cannot be matched reliably.
 */
const JWT_ERROR_CODES = new Set([
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
]);

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

  try {
    return await verifyJwsAccessToken(token, {
      jwksFetch: fetchJwksInProcess,
      verifyOptions: { audience: audiences, issuer },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : undefined;
    const code =
      err instanceof Error
        ? (err as Error & { code?: unknown }).code
        : undefined;
    const isJoseTokenError =
      typeof code === "string" && JWT_ERROR_CODES.has(code);
    // Better-Auth's local JWKS helper throws a plain `Error("Missing jwt kid")`
    // (`@better-auth/core/dist/oauth2/verify.mjs:31`) when the bearer token's
    // header lacks a `kid`. That is a token-shape problem, not infrastructure.
    const isMissingKid =
      err instanceof Error && err.message === "Missing jwt kid";
    const isJwtError = isJoseTokenError || isMissingKid;

    console.warn(
      JSON.stringify({
        event: isJwtError ? "mcp_auth_verify_failed" : "mcp_auth_verify_error",
        name,
        code: typeof code === "string" ? code : undefined,
        // Do NOT log `err.cause` — `JWTClaimValidationFailed` stores the
        // decoded JWT payload there.
        message: err instanceof Error ? err.message : String(err),
      }),
    );

    if (!isJwtError) throw err;
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
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized" },
      id: null,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
        "Access-Control-Expose-Headers": "WWW-Authenticate",
      },
    },
  );
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

  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
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
