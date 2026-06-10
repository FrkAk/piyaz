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
 * Populated from `MYMIR_VERIFIED_OAUTH_CLIENT_IDS` (comma-separated client
 * ids). Empty by default: with pure dynamic registration there are no
 * pre-trusted clients, so the safe default is to polish none. If official
 * clients are ever pre-registered with stable ids, list them here.
 *
 * @param clientId - The OAuth client id from the authorization request.
 * @returns True when the client is on the verified allowlist.
 */
export function isVerifiedOAuthClient(clientId: string): boolean {
  const raw = process.env.MYMIR_VERIFIED_OAUTH_CLIENT_IDS;
  if (!raw) return false;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(clientId);
}
