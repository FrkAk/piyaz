/**
 * Hosts trusted as redirect targets without warning the user. Localhost
 * variants cover the dev experience for MCP CLIs that round-trip a code
 * through an ephemeral loopback HTTP listener — see RFC 8252 §7.3 and the
 * VS Code MCP example at `http://127.0.0.1:<port>`.
 */
export const SAFE_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Custom URL schemes used by legitimate MCP CLIs that round-trip the
 * authorization code through the operating system's URL handler instead of
 * a loopback HTTP server. Intentionally narrow: every entry expands the
 * implicit-trust surface, so add only after auditing the client.
 */
export const SAFE_REDIRECT_SCHEMES: ReadonlySet<string> = new Set([
  "vscode:",
  "cursor:",
  "claude:",
]);

/**
 * Decide whether a resolved redirect URL is safe to hand to
 * `window.location.href`. Accepts only `http(s)` and the audited custom
 * schemes in {@link SAFE_REDIRECT_SCHEMES}; every other scheme
 * (`javascript:`, `data:`, `blob:`, ...) and any unparseable value is
 * rejected. This is the navigation gate — distinct from
 * {@link evaluateRedirect}, which only computes the display warning.
 *
 * @param url - The final redirect URL returned by the OAuth provider.
 * @returns True when the URL is safe to navigate to.
 */
export function isNavigableRedirectUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" ||
    parsed.protocol === "https:" ||
    SAFE_REDIRECT_SCHEMES.has(parsed.protocol)
  );
}

/**
 * Result of evaluating the OAuth `redirect_uri` against the safe-redirect
 * allowlist. Carries the user-facing host string so the page renders the
 * same value in both the "Redirecting to" row and the warning banner.
 */
export type RedirectEvaluation = {
  readonly safe: boolean;
  readonly display: string;
};

/**
 * Decide whether a `redirect_uri` is on the safe-redirect allowlist and
 * compute the user-facing host label. An `ownHost` of `null` (SSR) treats
 * the deployment host as unknown so the same-host fast path falls through
 * to the hostname allowlist check — fail-closed: a same-host URI then
 * renders as "unverified destination" until hydration completes.
 *
 * @param redirectUri - The `redirect_uri` from the signed authorize query.
 * @param ownHost - The deployment host or `null` when not yet hydrated.
 * @returns Verdict + display string. Unparseable URIs fail closed.
 */
export function evaluateRedirect(
  redirectUri: string | null,
  ownHost: string | null,
): RedirectEvaluation {
  if (!redirectUri) return { safe: false, display: "(missing)" };
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return { safe: false, display: redirectUri };
  }
  if (SAFE_REDIRECT_SCHEMES.has(parsed.protocol)) {
    return { safe: true, display: redirectUri };
  }
  const host = parsed.host;
  const hostname = parsed.hostname;
  if (SAFE_REDIRECT_HOSTS.has(hostname) || (ownHost && host === ownHost)) {
    return { safe: true, display: host };
  }
  return { safe: false, display: host || redirectUri };
}

/**
 * Parse a URL string and return its host (e.g. `claude.com`,
 * `acme.example:8443`). Returns `null` for any input the browser would
 * not navigate to as a normal http(s) link.
 *
 * Used by the consent page to annotate self-asserted DCR metadata links
 * (`client_uri` / `tos_uri` / `policy_uri`) with their destination host
 * so the user sees `Website (attacker.com)` before clicking — the link's
 * URL is attacker-controlled and unverified.
 *
 * @param url - Raw URL string from DCR client metadata.
 * @returns Host string for display, or `null` if the URL is unparseable
 *   or uses a non-http(s) scheme.
 */
export function safeLinkHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.host || null;
  } catch {
    return null;
  }
}
