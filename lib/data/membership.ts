import "server-only";
import { and, count, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { Conn } from "@/lib/db";
import { member, organization, user } from "@/lib/db/auth-schema";
import { decodeCursor, encodeCursor, type Cursor } from "@/lib/data/cursor";
import { acquireOwnerDemoteLock } from "@/lib/db/raw/acquire-owner-demote-lock";
import {
  previewTeamCascade,
  type TeamCascadePreview,
} from "@/lib/db/raw/preview-team-cascade";

/**
 * Fetch a page of teams the caller belongs to, with org metadata, member
 * role, and total member count. Sorted by `(organization.createdAt DESC, organization.id DESC)`.
 * The cursor's `updatedAt` field encodes `organization.createdAt` — the codec
 * is the same `encodeCursor`/`decodeCursor` used for project-list pagination.
 *
 * @param userId - Verified user id.
 * @param opts - Pagination options.
 * @returns Memberships, countByOrg map, and cursor for the next page.
 */
export async function listMembershipsWithCounts(
  userId: string,
  opts: { limit?: number; cursor?: Cursor | string | null } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const after = decodeCursor(opts.cursor);

  const cursorClause = after
    ? sql`(${organization.createdAt} < ${after.updatedAt.toISOString()}::timestamptz
            OR (${organization.createdAt} = ${after.updatedAt.toISOString()}::timestamptz
                AND ${organization.id} < ${after.id}))`
    : sql`TRUE`;

  const memberships = await db
    .select({
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      organizationCreatedAt: organization.createdAt,
      membershipCreatedAt: member.createdAt,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), cursorClause))
    .orderBy(desc(organization.createdAt), desc(organization.id))
    .limit(limit + 1);

  const hasMore = memberships.length > limit;
  const trimmed = hasMore ? memberships.slice(0, limit) : memberships;
  const last = trimmed[trimmed.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          updatedAt: last.organizationCreatedAt,
          id: last.organizationId,
        })
      : null;

  if (trimmed.length === 0) {
    return { memberships: trimmed, countByOrg: new Map<string, number>(), nextCursor };
  }

  const orgIds = trimmed.map((m) => m.organizationId);
  const counts = await db
    .select({
      organizationId: member.organizationId,
      memberCount: count(member.id).as("member_count"),
    })
    .from(member)
    .where(inArray(member.organizationId, orgIds))
    .groupBy(member.organizationId);

  const countByOrg = new Map(
    counts.map((c) => [c.organizationId, Number(c.memberCount)]),
  );
  return { memberships: trimmed, countByOrg, nextCursor };
}

/**
 * Check whether a user belongs to at least one organization. Used by the
 * onboarding RSC to skip the create-or-join form when membership exists.
 *
 * @param userId - Verified user id.
 * @returns True when the user has at least one membership row.
 */
export async function userHasAnyMembership(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  return row !== undefined;
}

/**
 * Fetch a single member row by id.
 *
 * @param memberId - UUID of the member row.
 * @returns The row or null.
 */
export async function findMemberById(memberId: string) {
  const [row] = await db
    .select({
      id: member.id,
      role: member.role,
      organizationId: member.organizationId,
    })
    .from(member)
    .where(eq(member.id, memberId))
    .limit(1);
  return row ?? null;
}

/**
 * Inside a transaction, fetch all member rows for a team. Used by the
 * last-owner guard in `updateMemberRoleAction`.
 *
 * @param tx - Drizzle transaction handle.
 * @param organizationId - UUID of the team.
 * @returns Roles of every member in the team.
 */
export async function listMemberRolesTx(tx: Conn, organizationId: string) {
  return tx
    .select({ role: member.role })
    .from(member)
    .where(eq(member.organizationId, organizationId));
}

/**
 * Inside a transaction, fetch the latest role + organization for a single
 * member. Used after acquiring the owner-demote lock.
 *
 * @param tx - Drizzle transaction handle.
 * @param memberId - UUID of the member row.
 * @returns The latest row or null.
 */
export async function findMemberByIdTx(tx: Conn, memberId: string) {
  const [row] = await tx
    .select({
      role: member.role,
      organizationId: member.organizationId,
    })
    .from(member)
    .where(eq(member.id, memberId))
    .limit(1);
  return row ?? null;
}

/**
 * Fetch the user ids of every member of an organization. Used by the
 * `beforeDeleteOrganization` hook to wipe per-member OAuth artifacts.
 *
 * @param organizationId - UUID of the team.
 * @returns User ids of every member.
 */
export async function findOrgMemberUserIds(
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, organizationId));
  return rows.map((r) => r.userId);
}

/**
 * Look up display names for a batch of user ids.
 *
 * @param userIds - User ids.
 * @returns Map of user id to display name.
 */
export async function lookupUserNames(
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, userIds));
  return new Map(rows.map((u) => [u.id, u.name]));
}

/**
 * Read the caller's role string for a given organization.
 *
 * @param userId - Verified user id.
 * @param organizationId - UUID of the organization.
 * @returns Role string, or null when the user has no membership row in the org.
 */
export async function findMemberRole(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

/** Resolved team-scope: the org row + the caller's role from the membership JOIN. */
export type TeamMembershipRow = {
  /** The authorized organization row. */
  organization: typeof organization.$inferSelect;
  /** Caller's `member.role` string from the same JOIN. */
  memberRole: string;
};

/**
 * Membership-gated team lookup. Returns null when the team doesn't exist
 * or the user is not a member of it.
 *
 * @param userId - Verified user id.
 * @param teamId - UUID of the team to authorize.
 * @returns Access row or null.
 */
export async function findTeamMembership(
  userId: string,
  teamId: string,
): Promise<TeamMembershipRow | null> {
  const [row] = await db
    .select({
      organization: getTableColumns(organization),
      memberRole: member.role,
    })
    .from(organization)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, organization.id),
        eq(member.userId, userId),
      ),
    )
    .where(eq(organization.id, teamId))
    .limit(1);
  return row ?? null;
}

/** Outcome of a guarded member-demote attempt. */
export type DemoteOutcome =
  | { kind: "ok" }
  | { kind: "fail"; code: "not_found" | "forbidden" | "cannot_leave_only_owner" }
  | { kind: "callback_error"; err: unknown };

/**
 * Atomically demote (or otherwise change the role of) a member, holding the
 * per-org owner-demote advisory lock so concurrent demotes serialize. The
 * actual role change is performed by the supplied `demote` callback — which
 * lets actions thread Better Auth's `updateMemberRole` through the lock
 * without `lib/data/` taking a dep on `auth.api`.
 *
 * The callback runs inside the transaction window but on its own connection
 * (BA's adapter is autocommit), so it doesn't deadlock against the lock —
 * the lock simply serializes other actions waiting on the same gate.
 *
 * @param input - Target team, member id, and role change parameters.
 * @param input.organizationId - UUID of the team.
 * @param input.memberId - UUID of the member row.
 * @param input.role - New role ("owner" | "admin" | "member").
 * @param input.roleIncludesOwner - Predicate the caller uses to detect "owner" in the raw role string.
 * @param demote - Callback that performs the actual role change (typically auth.api.updateMemberRole).
 * @returns Outcome discriminating success, validation failures, and callback errors.
 */
export async function demoteMemberWithGuard(
  input: {
    organizationId: string;
    memberId: string;
    role: "member" | "admin" | "owner";
    roleIncludesOwner: (role: string) => boolean;
  },
  demote: () => Promise<void>,
): Promise<DemoteOutcome> {
  return db.transaction(async (tx) => {
    await acquireOwnerDemoteLock(tx, input.organizationId);

    const latest = await findMemberByIdTx(tx, input.memberId);
    if (!latest) return { kind: "fail", code: "not_found" };
    if (latest.organizationId !== input.organizationId) {
      return { kind: "fail", code: "forbidden" };
    }

    const targetIsOwner = input.roleIncludesOwner(latest.role);
    const newIsOwner = input.role === "owner";
    if (targetIsOwner && !newIsOwner) {
      const owners = await listMemberRolesTx(tx, latest.organizationId);
      const ownerCount = owners.filter((m) => input.roleIncludesOwner(m.role)).length;
      if (ownerCount <= 1) return { kind: "fail", code: "cannot_leave_only_owner" };
    }

    try {
      await demote();
      return { kind: "ok" };
    } catch (err) {
      return { kind: "callback_error", err };
    }
  });
}

/**
 * Snapshot the project + task counts that a team-delete cascade will wipe.
 * Thin wrapper around the raw helper so callers in the action ring don't
 * need to thread a `Conn` themselves.
 *
 * @param organizationId - UUID of the team.
 * @returns Project and task counts.
 */
export async function previewTeamDelete(
  organizationId: string,
): Promise<TeamCascadePreview> {
  return previewTeamCascade(db, organizationId);
}
