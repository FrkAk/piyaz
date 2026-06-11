/**
 * UI-facing shape of an active OAuth (MCP device) session.
 *
 * Two timestamps are reported:
 * - `authorizedAt` reads `authTime` — when the user first consented. It
 *   stays stable across refresh-token rotations.
 * - `lastActiveAt` reads the active row's own `createdAt` — every refresh
 *   rotation creates a new row, so this updates whenever the integration
 *   exchanges a refresh for a new access token. We do NOT aggregate
 *   `oauthAccessToken` because BA's provider deletes access tokens on
 *   each rotation, so that table is effectively empty for live clients.
 *
 * Hosted in a pure-data module (no `'use server'`) so it can cross the
 * client/server boundary without dragging the server action surface
 * into client bundles. Mirrors the `TeamView` / `team-list-map.ts`
 * split.
 */
export type OAuthSessionView = {
  /** Refresh token id — stable identifier passed to revoke. */
  id: string;
  /** OAuth client id (string, not UUID — BA mints these via DCR). */
  clientId: string;
  /** Display name from oauthClient.name; falls back to clientId. */
  clientName: string;
  /**
   * Whether the client id is on the server-side verified allowlist
   * (`isVerifiedOAuthClient`). Computed server-side because the allowlist
   * env var must not reach the client bundle. The devices UI only renders
   * the polished brand label when true; otherwise the raw registered name
   * is shown so a spoofed client cannot hide under a trusted brand in the
   * audit/revoke list.
   */
  verified: boolean;
  /** Active organization scope, if the token is org-scoped. */
  organizationId: string | null;
  /** Display name of the organization, if joinable. */
  organizationName: string | null;
  /** Granted OAuth scopes. */
  scopes: string[];
  /** When the user authorized this client (consent time). */
  authorizedAt: Date;
  /** When this refresh row was last rotated — proxy for "last active". */
  lastActiveAt: Date;
  /** When the refresh token expires (null = no expiry set). */
  expiresAt: Date | null;
};
