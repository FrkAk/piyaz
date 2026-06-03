import { auth } from "@/lib/auth";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const origin = new URL(baseUrl).origin;
const mcpResource = `${origin}/api/mcp`;
const grantsNeedingResource = new Set(["authorization_code", "refresh_token"]);

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
    return auth.handler(request);
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
  return logTokenGrant(response, grantType, body.get("scope") ?? "");
}

/**
 * Log the outcome of an OAuth token grant for diagnosability (#108).
 *
 * Reads a clone so the original response stream is returned intact. Logs
 * only non-sensitive fields — never the issued tokens, the authorization
 * code, or client credentials. `error_description` is Better Auth's
 * user-facing OAuth error text and carries no secrets.
 *
 * @param response - Better Auth's token response.
 * @param grantType - The `grant_type` from the request.
 * @param requestScope - The `scope` parameter from the request, if any.
 * @returns The original `response`, unconsumed.
 */
async function logTokenGrant(
  response: Response,
  grantType: string,
  requestScope: string,
): Promise<Response> {
  let refreshTokenIssued = false;
  let grantedScope: string | undefined;
  let error: string | undefined;
  let errorDescription: string | undefined;

  try {
    const data = (await response.clone().json()) as Record<string, unknown>;
    refreshTokenIssued = typeof data.refresh_token === "string";
    grantedScope = typeof data.scope === "string" ? data.scope : undefined;
    error = typeof data.error === "string" ? data.error : undefined;
    errorDescription =
      typeof data.error_description === "string"
        ? data.error_description
        : undefined;
  } catch {
    // Non-JSON body (not expected for the token endpoint).
  }

  const line = JSON.stringify({
    event: "oauth_token_grant",
    grant_type: grantType,
    status: response.status,
    requested_offline_access: requestScope
      .split(" ")
      .includes("offline_access"),
    granted_scope: grantedScope,
    refresh_token_issued: refreshTokenIssued,
    error,
    error_description: errorDescription,
  });

  if (response.ok && !error) console.info(line);
  else console.warn(line);

  return response;
}
