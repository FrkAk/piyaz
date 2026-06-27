const CLIENT_METADATA_SUFFIX = /\s+\((?:plugin|mcp):[^)]*\)\s*$/i;

/**
 * Unicode format (`Cf`: zero-width space/joiner, RTL override, …) and
 * control (`Cc`) characters. Whitespace-class controls (`\t`, `\n`, …)
 * are collapsed to plain spaces before this strip runs, so the strip
 * only ever removes invisible characters that would otherwise let a
 * registered name visually impersonate another (e.g. "Claude​Code"
 * rendering as "Claude Code").
 */
const INVISIBLE_CHARS = /[\p{Cf}\p{Cc}]/gu;

/**
 * Normalize a raw registered client name for safe display: collapse
 * whitespace runs to single spaces, strip invisible format/control
 * characters, and trim.
 *
 * @param clientName - Raw OAuth client name from Better Auth.
 * @returns Visually unambiguous display string.
 */
function sanitizeClientName(clientName: string): string {
  return clientName.replace(/\s+/g, " ").replace(INVISIBLE_CHARS, "").trim();
}

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
 * Canonical brand families in Agents & devices drawer order. Single source of
 * truth for both the {@link OAuthBrandFamily} union and the order the drawers
 * render in, so the grouped buckets and the rendered sections cannot drift.
 */
export const OAUTH_BRAND_FAMILIES = [
  "Claude",
  "Codex",
  "Antigravity",
  "Cursor",
] as const;

/** Canonical brand family — the Agents & devices drawer a client groups into. */
export type OAuthBrandFamily = (typeof OAUTH_BRAND_FAMILIES)[number];

/**
 * Single source of truth for first-party OAuth client recognition. Each row
 * maps a registered-name pattern to the audit-page drawer it groups into
 * (`family`) and, for clients that are a distinct product, the canonical label
 * shown on the consent screen for verified clients (`label`). Rows are matched
 * top-down and the first hit wins, so more specific patterns (e.g. "Claude
 * Code") must precede broader ones (e.g. "Claude") — reordering changes which
 * row matches.
 */
const OAUTH_CLIENT_BRANDS: readonly {
  readonly match: RegExp;
  readonly family: OAuthBrandFamily;
  readonly label?: string;
}[] = [
  { match: /^claude code\b/i, family: "Claude", label: "Claude Code" },
  { match: /^claude\b/i, family: "Claude" },
  { match: /^codex\b/i, family: "Codex", label: "Codex" },
  { match: /^cursor\b/i, family: "Cursor", label: "Cursor" },
  { match: /^gemini(?: cli)?\b/i, family: "Antigravity", label: "Gemini" },
  {
    match: /^(?:google )?antigravity\b/i,
    family: "Antigravity",
    label: "Antigravity",
  },
];

/**
 * Resolve the family drawer for the Agents & devices audit page.
 *
 * Unlike {@link formatOAuthClientName} (consent display, gated on `verified`),
 * grouping always normalizes — strips the `(plugin:…)`/`(mcp:…)` suffix and
 * matches by family — because the audit list groups already-authorized
 * sessions and renders each client's raw name on the row, so the grouping is a
 * convenience, not a trust assertion. A spoofed name therefore lands in the
 * matching drawer too; the visible raw name keeps it auditable.
 *
 * @param clientName - Raw OAuth client name from Better Auth.
 * @returns Canonical family label, or null when no family matches.
 */
export function resolveOAuthBrand(clientName: string): OAuthBrandFamily | null {
  const baseName = stripClientMetadata(sanitizeClientName(clientName));
  return (
    OAUTH_CLIENT_BRANDS.find(({ match }) => match.test(baseName))?.family ?? null
  );
}

/**
 * Format an OAuth client name for display.
 *
 * Brand normalization (stripping the `(plugin:…)` suffix and collapsing a
 * name onto a canonical brand label) is only safe for clients we trust,
 * because dynamic client registration lets anyone register an arbitrary name.
 * When `verified` is false the raw registered name is returned with only
 * whitespace tidied and invisible characters stripped — no suffix stripping,
 * no brand collapse — so a spoofed `"Claude Code (plugin:evil)"` is shown
 * verbatim rather than laundered into "Claude Code", and a zero-width or
 * RTL-override payload cannot render as a visual lookalike. The flag is
 * required — not defaulted — so no call site can silently opt into brand
 * polish; derive it from the server-side check (`isVerifiedOAuthClient`)
 * everywhere the name participates in a trust decision (consent, device
 * audit).
 *
 * @param clientName - Raw OAuth client name from Better Auth.
 * @param verified - Whether the client_id is on the verified allowlist.
 * @returns User-facing client label.
 */
export function formatOAuthClientName(
  clientName: string,
  verified: boolean,
): string {
  const cleaned = sanitizeClientName(clientName);
  if (!verified) return cleaned;
  const baseName = stripClientMetadata(cleaned);
  const brand = OAUTH_CLIENT_BRANDS.find(({ match }) => match.test(baseName));
  return brand?.label ?? baseName;
}
