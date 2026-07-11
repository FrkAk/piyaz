/**
 * Tiny client-side SWR cache for team-management drill-ins. Keyed by team
 * id; entries hold the three lazy-fetched payloads plus the timestamp at
 * which they were captured. The panel reads the cache on open to render
 * immediately and kicks off a background refetch when the entry is older
 * than `FRESH_WINDOW_MS`.
 *
 * Module-level state is intentional — the cache is a per-tab session
 * accelerator, not durable storage. It clears automatically on full
 * reload (module re-eval) and on tab close.
 */

import type { MemberView } from "@/lib/actions/team-members-map";
import type { InvitationView } from "@/lib/actions/team-invitations-map";
import type { InviteCodeMetadata } from "@/lib/actions/team-invite-code";
import type { DpaAcceptanceState } from "@/lib/actions/legal";

/** Fresh-window beyond which the cache is shown but a background refetch fires. */
const FRESH_WINDOW_MS = 30_000;

/** Snapshot of everything the panel renders for one team. */
export interface TeamManagePayload {
  /** Members list (sorted by role then name). */
  members: MemberView[];
  /** Pending invitations — empty for non-admin viewers (server returns forbidden). */
  invitations: InvitationView[];
  /** Invite-code metadata — null for non-admin viewers. */
  inviteCode: InviteCodeMetadata | null;
  /** Latest known team display name (mirrors identity edits). */
  teamName: string;
  /** Latest known team slug. */
  teamSlug: string;
  /** Owner's DPA acceptance state — null for non-owners or when not yet accepted. */
  dpaAcceptance: DpaAcceptanceState | null;
}

interface CacheEntry {
  payload: TeamManagePayload;
  fetchedAt: number;
}

const CACHE = new Map<string, CacheEntry>();

/**
 * Get a cached payload for `teamId`.
 *
 * @param teamId - Team UUID to look up.
 * @returns Object with `payload` and `fresh` flag, or `null` if the cache
 *   has no entry. `fresh` is `true` when the entry is younger than the
 *   freshness window — callers can skip the background refetch in that
 *   case.
 */
export function readTeamManageCache(
  teamId: string,
): { payload: TeamManagePayload; fresh: boolean } | null {
  const entry = CACHE.get(teamId);
  if (!entry) return null;
  return {
    payload: entry.payload,
    fresh: Date.now() - entry.fetchedAt < FRESH_WINDOW_MS,
  };
}

/**
 * Store a payload in the cache, replacing any existing entry.
 *
 * @param teamId - Team UUID.
 * @param payload - Snapshot to retain until the next replace.
 */
export function writeTeamManageCache(
  teamId: string,
  payload: TeamManagePayload,
): void {
  CACHE.set(teamId, { payload, fetchedAt: Date.now() });
}

/**
 * Patch the cached payload in place. No-ops when the team has no cached
 * entry yet — used to thread optimistic mutations (role change, invite,
 * rename) into the cache so the next open shows the latest state.
 *
 * @param teamId - Team UUID.
 * @param patch - Partial payload to merge into the existing entry.
 */
export function updateTeamManageCache(
  teamId: string,
  patch: Partial<TeamManagePayload>,
): void {
  const entry = CACHE.get(teamId);
  if (!entry) return;
  CACHE.set(teamId, {
    payload: { ...entry.payload, ...patch },
    fetchedAt: entry.fetchedAt,
  });
}

/**
 * Forget any cached entry for `teamId` — used when the user leaves or
 * deletes the team so the next open re-fetches from scratch instead of
 * showing stale data the server will reject.
 *
 * @param teamId - Team UUID.
 */
export function invalidateTeamManageCache(teamId: string): void {
  CACHE.delete(teamId);
}

/**
 * Drop every cached entry. Defense-in-depth helper invoked on identity
 * changes (sign-out, account switch) so a previous user's team payloads
 * don't linger in JS memory after the auth boundary changes — even
 * though UUIDs prevent cross-user UI exposure.
 */
export function clearTeamManageCache(): void {
  CACHE.clear();
}
