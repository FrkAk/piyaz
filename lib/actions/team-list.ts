"use server";

import { requireLegalConsent } from "@/lib/auth/consent";
import { requireSession } from "@/lib/auth/session";
import { teamFail, type TeamActionResult } from "@/lib/actions/team-errors";
import { mapTeamViews, type TeamView } from "@/lib/actions/team-list-map";
import { listMembershipsWithCounts } from "@/lib/data/membership";
import type { Cursor } from "@/lib/data/cursor";

export type { TeamView } from "@/lib/actions/team-list-map";

/** Paginated team list result. */
export type ListTeamsResult = {
  rows: TeamView[];
  nextCursor: Cursor | null;
};

/**
 * List every team the caller is a member of (up to 100), decorated with
 * their role and total member count. Returns a flat array for backward
 * compatibility — use {@link listUserTeamsPagedAction} for cursor-based access.
 *
 * @returns Discriminated result; `data` is the team list.
 */
export async function listUserTeamsAction(): Promise<
  TeamActionResult<TeamView[]>
> {
  const result = await listUserTeamsPagedAction({ limit: 100 });
  if (!result.ok) return result;
  return { ok: true, data: result.data.rows };
}

/**
 * Paginated version of {@link listUserTeamsAction}. Returns a page of teams
 * plus a cursor for the next slice.
 *
 * @param input - Optional limit and cursor.
 * @returns Discriminated result; `data` contains rows and nextCursor.
 */
export async function listUserTeamsPagedAction(
  input: { limit?: number; cursor?: string | null } = {},
): Promise<TeamActionResult<ListTeamsResult>> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  await requireLegalConsent(userId);

  try {
    const { memberships, countByOrg, nextCursor } =
      await listMembershipsWithCounts(userId, {
        limit: input.limit,
        cursor: input.cursor,
      });
    return {
      ok: true,
      data: { rows: mapTeamViews(memberships, countByOrg), nextCursor },
    };
  } catch (err) {
    console.error("listUserTeamsPagedAction failed", err);
    return teamFail("unknown");
  }
}
