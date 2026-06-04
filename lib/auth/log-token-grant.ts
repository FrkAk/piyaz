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
export async function logTokenGrant(
  response: Response,
  grantType: string,
  requestScope: string,
): Promise<Response> {
  const data = (await response
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>;

  const context = {
    grant_type: grantType,
    status: response.status,
    requested_scope: requestScope || undefined,
    granted_scope: typeof data.scope === "string" ? data.scope : undefined,
    refresh_token_issued: typeof data.refresh_token === "string",
    error: typeof data.error === "string" ? data.error : undefined,
    error_description:
      typeof data.error_description === "string"
        ? data.error_description
        : undefined,
  };

  if (response.ok && !context.error) console.info("oauth_token_grant", context);
  else console.warn("oauth_token_grant", context);

  return response;
}
