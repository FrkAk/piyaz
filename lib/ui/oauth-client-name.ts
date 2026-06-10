const CLIENT_METADATA_SUFFIX = /\s+\((?:plugin|mcp):[^)]*\)\s*$/i;

const CLIENT_BRAND_LABELS: readonly {
  readonly match: RegExp;
  readonly label: string;
}[] = [
  { match: /^claude code\b/i, label: "Claude Code" },
  { match: /^codex\b/i, label: "Codex" },
  { match: /^cursor\b/i, label: "Cursor" },
  { match: /^(?:google )?antigravity\b/i, label: "Antigravity" },
  { match: /^gemini(?: cli)?\b/i, label: "Gemini" },
];

/**
 * Remove client registration metadata from an OAuth client name.
 *
 * @param clientName - Raw OAuth client name from Better Auth.
 * @returns Name without known trailing metadata suffixes.
 */
function stripClientMetadata(clientName: string): string {
  return clientName.trim().replace(CLIENT_METADATA_SUFFIX, "").trim();
}

/**
 * Format an OAuth client name for display.
 *
 * Brand normalization (stripping the `(plugin:…)` suffix and collapsing a
 * name onto a canonical brand label) is only safe for clients we trust,
 * because dynamic client registration lets anyone register an arbitrary name.
 * When `verified` is false the raw registered name is returned with only
 * whitespace tidied — no suffix stripping, no brand collapse — so a spoofed
 * `"Claude Code (plugin:evil)"` is shown verbatim rather than laundered into
 * "Claude Code". Callers on the security-sensitive consent screen MUST pass
 * the real verified flag (see `isVerifiedOAuthClient`); the post-authorization
 * devices list, where the user already approved the client, defaults to the
 * polished label.
 *
 * @param clientName - Raw OAuth client name from Better Auth.
 * @param verified - Whether the client_id is on the verified allowlist.
 *   Defaults to true (polished) for the post-auth devices UI.
 * @returns User-facing client label.
 */
export function formatOAuthClientName(
  clientName: string,
  verified = true,
): string {
  if (!verified) return clientName.trim().replace(/\s+/g, " ");
  const baseName = stripClientMetadata(clientName).replace(/\s+/g, " ");
  const brand = CLIENT_BRAND_LABELS.find(({ match }) => match.test(baseName));
  return brand?.label ?? baseName;
}
