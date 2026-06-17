import "server-only";

/**
 * Allowlist of OAuth `client_id`s trusted enough to render with canonical
 * brand polish (e.g. the bare label "Claude Code") on the consent screen.
 *
 * Dynamic client registration is open on this deployment (anyone can POST a
 * client with any `client_name`), so normalizing a *name* into a trusted
 * brand would let an attacker register `"Claude Code (plugin:evil)"` and have
 * the consent screen present it as the trusted "Claude Code". Brand polish is
 * therefore gated on the `client_id` — a value the attacker cannot choose —
 * not on the name. Clients not on this list render their raw registered name
 * verbatim so the user sees exactly what asked for access.
 *
 * Populated from `PIYAZ_VERIFIED_OAUTH_CLIENT_IDS` (comma-separated client
 * ids). The parsed set is memoized keyed on the raw env string — env vars
 * are fixed per deploy on both Workers and self-host, so in practice the
 * parse runs once per process/isolate, and the re-key keeps the function
 * testable without a cache-reset hook. Empty by default: with pure dynamic
 * registration there are no pre-trusted clients, so the safe default is to
 * polish none. If official clients are ever pre-registered with stable ids,
 * list them here.
 */
let cachedRaw: string | null = null;
let verifiedClientIds: ReadonlySet<string> = new Set();

/**
 * Check whether a client id is on the verified allowlist.
 *
 * @param clientId - The OAuth client id from the authorization request.
 * @returns True when the client is on the verified allowlist.
 */
export function isVerifiedOAuthClient(clientId: string): boolean {
  const raw = process.env.PIYAZ_VERIFIED_OAUTH_CLIENT_IDS ?? "";
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    verifiedClientIds = new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }
  return verifiedClientIds.has(clientId);
}
