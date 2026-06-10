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
 * Format an OAuth client name for the devices UI.
 *
 * @param clientName - Raw OAuth client name from Better Auth.
 * @returns Stable user-facing client label.
 */
export function formatOAuthClientName(clientName: string): string {
  const baseName = stripClientMetadata(clientName).replace(/\s+/g, " ");
  const brand = CLIENT_BRAND_LABELS.find(({ match }) => match.test(baseName));
  return brand?.label ?? baseName;
}
