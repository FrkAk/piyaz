/**
 * OAuth access-token lifetime Better Auth mints (`accessTokenExpiresIn` in
 * `lib/auth.ts`). This is the revocation lag, not the session length:
 * `/api/mcp` verifies by signature alone and never reads revocation state,
 * so an outstanding token stays usable until it expires.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Render a TTL as user-facing copy.
 *
 * @param seconds - TTL in seconds.
 * @returns Human-readable duration ("an hour", "2 hours", "30 minutes").
 */
function formatTtl(seconds: number): string {
  if (seconds === 3600) return "an hour";
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${Math.max(1, Math.round(seconds / 60))} minutes`;
}

/**
 * Revocation-lag sentence for every surface whose flow revokes agent access.
 * Derived from {@link ACCESS_TOKEN_TTL_SECONDS}, so tuning the TTL updates
 * each of them instead of leaving stale copy behind.
 */
export const REVOCATION_LAG_HINT = `Access already granted can take up to ${formatTtl(
  ACCESS_TOKEN_TTL_SECONDS,
)} to stop working.`;
