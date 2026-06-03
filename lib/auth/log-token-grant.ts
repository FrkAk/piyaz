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
