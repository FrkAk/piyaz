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
 * whitespace tidied and invisible characters stripped — no suffix stripping,
 * no brand collapse — so a spoofed `"Claude Code (plugin:evil)"` is shown
 * verbatim rather than laundered into "Claude Code", and a zero-width or
 * RTL-override payload cannot render as a visual lookalike. Callers on the
 * security-sensitive consent screen MUST pass the real verified flag (see
 * `isVerifiedOAuthClient`); pass the flag everywhere the name participates
 * in a trust decision (consent, device audit).
 *
 * @param clientName - Raw OAuth client name from Better Auth.
 * @param verified - Whether the client_id is on the verified allowlist.
 *   Defaults to true (polished) for display-only contexts.
 * @returns User-facing client label.
 */
export function formatOAuthClientName(
  clientName: string,
  verified = true,
): string {
  const cleaned = sanitizeClientName(clientName);
  if (!verified) return cleaned;
  const baseName = stripClientMetadata(cleaned);
  const brand = CLIENT_BRAND_LABELS.find(({ match }) => match.test(baseName));
  return brand?.label ?? baseName;
}
