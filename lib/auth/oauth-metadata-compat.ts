/**
 * RFC 9207 discovery field advertising that authorization responses carry an
 * `iss` parameter. Better Auth hardcodes it to `true`
 * (`@better-auth/oauth-provider@1.6.23`, `dist/index.mjs:4066`) with no option
 * to disable it.
 */
const ISS_ADVERTISEMENT_FIELD =
  "authorization_response_iss_parameter_supported";

/**
 * Header every MCP client sends on discovery requests, and the signal this
 * module gates on. Client identity is not usable: Codex sends no `User-Agent`
 * on OAuth discovery at the affected releases, because `build_default_headers`
 * starts from an empty `HeaderMap` (`codex-rs/rmcp-client/src/utils.rs` at
 * `rust-v0.145.0`), and `main` has since started setting one.
 */
const MCP_CLIENT_HEADER = "mcp-protocol-version";

/**
 * TODO(PYZ-360): remove this module once Codex forwards `iss`.
 *
 * Codex cannot complete an MCP OAuth login against any server advertising
 * `authorization_response_iss_parameter_supported` (openai/codex#31573, open
 * and unfixed on `main` as of codex-cli 0.145.0). Its callback parser at
 * `codex-rs/rmcp-client/src/perform_oauth_login.rs:352-356` matches only
 * `code` and `state`, dropping `iss` into a catch-all, then calls the
 * issuer-less `handle_callback` at line 612. The bundled `rmcp` derives
 * `require_issuer` from this field, so it demands an issuer Codex never
 * forwards and fails every login with `AuthorizationServerMissingIssuer`.
 *
 * The compatibility document is served only to MCP clients and is marked
 * `no-store`, so the compliant document stays the default and the only
 * cacheable variant. A cache that ignores `Vary` can therefore only serve the
 * compliant document to an MCP client, which fails the login exactly as it
 * does today; it can never relax the issuer requirement for anyone else.
 *
 * Authorization responses continue to carry `iss` for every client, so
 * validation remains possible throughout.
 *
 * @param request - Incoming discovery request.
 * @param response - Discovery metadata response from Better Auth. Its `Vary`
 *   header is amended in place, matching `ensureCacheControl`.
 * @returns The same response for non-MCP clients, or a new uncacheable
 *   response without the `iss` advertisement for MCP clients.
 */
export async function applyIssAdvertisementCompat(
  request: Request,
  response: Response,
): Promise<Response> {
  response.headers.append("vary", MCP_CLIENT_HEADER);

  const isMcpClient = request.headers.has(MCP_CLIENT_HEADER);
  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");
  if (!isMcpClient || !response.ok || !isJson) {
    return response;
  }

  const metadata = (await response.json()) as Record<string, unknown>;
  delete metadata[ISS_ADVERTISEMENT_FIELD];

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return new Response(JSON.stringify(metadata), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
