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
 * ids), parsed once per process/isolate — env vars are fixed per deploy on
 * both Workers and self-host, so per-call re-parsing buys nothing.
 * Empty by default: with pure dynamic registration there are no
 * pre-trusted clients, so the safe default is to polish none. If official
 * clients are ever pre-registered with stable ids, list them here.
 */
let verifiedClientIds: ReadonlySet<string> | null = null;

/**
 * Check whether a client id is on the verified allowlist.
 *
 * @param clientId - The OAuth client id from the authorization request.
 * @returns True when the client is on the verified allowlist.
 */
export function isVerifiedOAuthClient(clientId: string): boolean {
  verifiedClientIds ??= new Set(
    (process.env.MYMIR_VERIFIED_OAUTH_CLIENT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return verifiedClientIds.has(clientId);
}
