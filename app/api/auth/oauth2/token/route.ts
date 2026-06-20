import { auth } from "@/lib/auth";
import { logTokenGrant } from "@/lib/auth/log-token-grant";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const origin = new URL(baseUrl).origin;
const mcpResource = `${origin}/api/mcp`;
const grantsNeedingResource = new Set(["authorization_code", "refresh_token"]);

/**
 * Backfill `Cache-Control: no-store` when the response does not already
 * carry the header. Better Auth's oauth-provider sets `no-store` on the
 * token response today (`@better-auth/oauth-provider/dist/index.mjs:600`),
 * so this is a no-op-on-write; the guard makes the contract project-owned
 * so a future BA upgrade that drops the header cannot silently regress it.
 *
 * @param response - Response returned by `auth.handler`.
 * @returns The same response, with `Cache-Control: no-store` ensured.
 */
function withNoStore(response: Response): Response {
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", "no-store");
  }
  return response;
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
 * @param request - Incoming POST to `/api/auth/oauth2/token`.
 * @returns Better Auth token response.
 */
export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return withNoStore(await auth.handler(request));
  }

  const body = new URLSearchParams(await request.text());
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
  return withNoStore(
    await logTokenGrant(response, grantType, body.get("scope") ?? ""),
  );
}
