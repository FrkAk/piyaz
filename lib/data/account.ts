import "server-only";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { serviceRoleDb } from "@/lib/db";
import { authDb } from "@/lib/db/connection";
import { executeRaw, normalizeExecuteResult, toDate } from "@/lib/db/raw";
import { withUserContextRead } from "@/lib/db/rls";
import {
  account,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@/lib/db/auth-schema";
import {
  legalAcceptances,
  projects,
  tasks,
  taskAssignees,
} from "@/lib/db/schema";
import { parseMemberRoles } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/context";

/** The caller's own profile, resolved for the MCP whoami surface. */
export type Whoami = { userId: string; name: string; email: string };

/**
 * Read the caller's own user profile (id, name, email) in one RLS-scoped read.
 * `app_user` has no grant on `piyaz_auth."user"`, so the row is resolved via
 * the `current_user_profile` SECURITY DEFINER function, which binds to the
 * session's `app.user_id` GUC and can never disclose another user's row.
 *
 * @param ctx - Caller auth context.
 * @returns The caller's user id, name, and email.
 * @throws Error when no profile row resolves for the caller.
 */
export async function getWhoami(ctx: AuthContext): Promise<Whoami> {
  const [raw] = await withUserContextRead(ctx.userId, (read) => [
    read.execute(
      sql`SELECT user_id, name, email FROM public.current_user_profile()`,
    ),
  ]);
  const [row] = normalizeExecuteResult<{
    user_id: string;
    name: string;
    email: string;
  }>(raw);
  if (!row) {
    throw new Error(`getWhoami: no profile row for caller ${ctx.userId}`);
  }
  return { userId: row.user_id, name: row.name, email: row.email };
}

/**
 * Read when the user's credential (email/password) account row last
 * changed. The row's `updatedAt` bumps on every password write, so it
 * doubles as "password last changed" for the settings UI.
 *
 * Reads through `authDb` (auth_role): `piyaz_auth.account` holds password
 * hashes, so `docker/grants-auth.sql` deliberately excludes it from
 * `service_role`'s table grants. Only the auth layer's role may touch it.
 *
 * @param userId - Verified user id from the session.
 * @returns The credential row's `updatedAt`, or null when the user has no
 *          password-bearing credential account.
 */
export async function getPasswordUpdatedAt(
  userId: string,
): Promise<Date | null> {
  const rows = await authDb
    .select({ updatedAt: account.updatedAt })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, "credential"),
        isNotNull(account.password),
      ),
    )
    .limit(1);
  return rows[0]?.updatedAt ?? null;
}

/**
 * Wipe every artifact that referenced (userId, orgId) so a removed member
 * cannot keep operating with stale credentials. All four writes commit
 * together — concurrent readers see either the pre- or post-state.
 *
 * Called from:
 * - `organizationHooks.afterRemoveMember` (admin removes another member)
 * - `leaveTeamAction` directly (Better Auth's `leaveOrganization` does NOT
 *   fire any organization hook, so the call site must invoke cleanup itself)
 * - `organizationHooks.beforeDeleteOrganization` (per-member loop before
 *   the org row is deleted; member rows then cascade)
 *
 * `orgId` MUST come from a verified Better Auth hook or action context — a
 * wrong `orgId` here deletes the user's assignments in that org (blast radius
 * is one user × one org, never another user's rows because of the
 * `taskAssignees.userId = userId` outer scope).
 *
 * @param userId - Owner of the artifacts to remove.
 * @param orgId - Organization the artifacts pointed at.
 */
export async function clearOrgMembershipArtifacts(
  userId: string,
  orgId: string,
): Promise<void> {
  await serviceRoleDb.transaction(async (tx) => {
    await tx
      .update(session)
      .set({ activeOrganizationId: null })
      .where(
        and(
          eq(session.userId, userId),
          eq(session.activeOrganizationId, orgId),
        ),
      );
    await tx
      .delete(oauthAccessToken)
      .where(
        and(
          eq(oauthAccessToken.userId, userId),
          eq(oauthAccessToken.referenceId, orgId),
        ),
      );
    await tx
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.userId, userId),
          eq(oauthRefreshToken.referenceId, orgId),
        ),
      );
    // BA's `oauthConsent` lookup keys on (clientId, userId) only, but
    // piyaz wires `consentReferenceId → activeOrganizationId` so the row
    // carries an org pointer that ends up in the access-token claims.
    // Deleting org-scoped consent rows forces re-consent for that client
    // so a removed member can't mint tokens claiming the old org.
    await tx
      .delete(oauthConsent)
      .where(
        and(
          eq(oauthConsent.userId, userId),
          eq(oauthConsent.referenceId, orgId),
        ),
      );
    // `task_assignees` FK to `piyaz_auth.user` only cascades on full user
    // deletion, not on team-membership removal. A removed member would
    // otherwise keep appearing in `getTaskFull(...).assignees` for tasks
    // in the org they left. Scrub their junction rows scoped to tasks
    // whose parent project lives in this org.
    const orgTaskIds = tx
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.organizationId, orgId));
    await tx
      .delete(taskAssignees)
      .where(
        and(
          eq(taskAssignees.userId, userId),
          inArray(taskAssignees.taskId, orgTaskIds),
        ),
      );
  });
}

/** One org the caller owns, with its member and owner counts. */
export type OwnedOrgForDeletion = {
  /** Organization UUID. */
  orgId: string;
  /** Total members in the org. */
  memberCount: number;
  /** Members whose role includes `owner`. */
  ownerCount: number;
};

/**
 * Enumerate every org the user owns, with per-org member and owner counts.
 * Routes through the `find_user_org_memberships_as_admin` SECURITY DEFINER
 * function because the account-delete `beforeDelete` hook runs with no
 * `app.user_id` GUC. Owner detection reuses the canonical
 * `parseMemberRoles`, so it matches the last-owner guard in
 * `lib/actions/team.ts` exactly and cannot drift from a SQL reimplementation.
 *
 * @param userId - Verified user id from the delete hook.
 * @returns One entry per owned org; empty when the user owns none.
 */
export async function enumerateOwnedOrgsForDeletion(
  userId: string,
): Promise<OwnedOrgForDeletion[]> {
  const rows = await executeRaw<{
    org_id: string;
    member_user_id: string;
    member_role: string;
  }>(
    serviceRoleDb,
    sql`SELECT org_id, member_user_id, member_role FROM public.find_user_org_memberships_as_admin(${userId}::uuid)`,
  );
  const byOrg = new Map<string, Array<{ userId: string; role: string }>>();
  for (const row of rows) {
    const members = byOrg.get(row.org_id) ?? [];
    members.push({ userId: row.member_user_id, role: row.member_role });
    byOrg.set(row.org_id, members);
  }
  const owned: OwnedOrgForDeletion[] = [];
  for (const [orgId, members] of byOrg) {
    const caller = members.find((m) => m.userId === userId);
    if (!caller || !parseMemberRoles(caller.role).includes("owner")) continue;
    const ownerCount = members.filter((m) =>
      parseMemberRoles(m.role).includes("owner"),
    ).length;
    owned.push({ orgId, memberCount: members.length, ownerCount });
  }
  return owned;
}

/** Decision for the account-delete cascade over the caller's owned orgs. */
export type OwnedOrgDeletionPlan =
  | { kind: "blocked"; orgId: string }
  | { kind: "ok"; orgIdsToDelete: string[] };

/**
 * Classify the caller's owned orgs for account deletion. An org the caller
 * solely owns that still has other members blocks the delete — the caller
 * must transfer ownership or delete the team first. An org the caller is
 * the only member of is deleted as part of the cascade so it is never
 * orphaned. A co-owned org needs no action: the caller's membership row
 * cascades on user deletion and the remaining owners keep the team.
 *
 * @param owned - Owned orgs with member and owner counts.
 * @returns `blocked` naming the first offending org, or `ok` with the org
 *          ids to delete.
 */
export function planOwnedOrgDeletion(
  owned: OwnedOrgForDeletion[],
): OwnedOrgDeletionPlan {
  const blocker = owned.find((o) => o.ownerCount === 1 && o.memberCount > 1);
  if (blocker) return { kind: "blocked", orgId: blocker.orgId };
  const orgIdsToDelete = owned
    .filter((o) => o.memberCount === 1)
    .map((o) => o.orgId);
  return { kind: "ok", orgIdsToDelete };
}

/**
 * Anonymize the caller's `legal_acceptances` rows in place: null
 * `ip_address` and `user_agent` while retaining `document_type`,
 * `document_version`, and `accepted_at` as contract evidence. `user_id`
 * is nulled by the FK `ON DELETE SET NULL` when the user row is removed,
 * so this scrub must run in `beforeDelete` while `user_id` is still
 * populated. Verifies the write landed and retries once; a persistent
 * failure throws so the account is never deleted with a compliance gap.
 * Zero acceptance rows is a valid success.
 *
 * @param userId - Verified user id from the delete hook.
 * @throws Error when rows still carry ip/user-agent after one retry.
 */
export async function scrubLegalAcceptances(userId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await serviceRoleDb
      .update(legalAcceptances)
      .set({ ipAddress: null, userAgent: null })
      .where(eq(legalAcceptances.userId, userId));
    const remaining = await serviceRoleDb
      .select({ id: legalAcceptances.id })
      .from(legalAcceptances)
      .where(
        and(
          eq(legalAcceptances.userId, userId),
          or(
            isNotNull(legalAcceptances.ipAddress),
            isNotNull(legalAcceptances.userAgent),
          ),
        ),
      );
    if (remaining.length === 0) return;
  }
  throw new Error(
    `scrubLegalAcceptances: rows for user ${userId} still carry ip/user-agent after retry`,
  );
}

/**
 * Delete an organization the user is the sole member of, letting the FK
 * cascade wipe member rows, invitations, and every project with its tasks
 * and edges.
 *
 * Exists for the account-deletion hook's memberless-owned-team cascade: the
 * reentrant `auth.api.deleteOrganization` path requires a request context
 * that server-action dispatch (`auth.api.deleteUser` with headers only)
 * never carries. Routes through the `delete_sole_member_org_as_admin`
 * SECURITY DEFINER function, which refuses unless the org's only member row
 * belongs to `userId`, so no other member can ever lose access through this
 * path. Ownership is verified by the caller via `planOwnedOrgDeletion`.
 *
 * @param organizationId - Organization to delete.
 * @param userId - The deleting user; must be the org's sole member.
 * @throws Error when the database refuses the delete (invariant not met).
 */
export async function deleteSoleMemberOrgAsAdmin(
  organizationId: string,
  userId: string,
): Promise<void> {
  const rows = await executeRaw<{ deleted: boolean }>(
    serviceRoleDb,
    sql`SELECT public.delete_sole_member_org_as_admin(${organizationId}::uuid, ${userId}::uuid) AS deleted`,
  );
  if (rows[0]?.deleted !== true) {
    throw new Error(
      `deleteSoleMemberOrgAsAdmin: refused for org ${organizationId}; the user is not its sole member`,
    );
  }
}

/** A single team membership in the account export. */
export type AccountExportMembership = {
  /** Organization UUID. */
  organizationId: string;
  /** The caller's role string in the org. */
  role: string;
  /** ISO timestamp the caller joined. */
  createdAt: string;
};

/** A single legal acceptance in the account export. */
export type AccountExportAcceptance = {
  /** Document type (`terms`, `privacy`, `dpa`). */
  documentType: string;
  /** Accepted document version. */
  documentVersion: string;
  /** ISO timestamp of acceptance. */
  acceptedAt: string;
  /** Caller's own recorded IP, or null. */
  ipAddress: string | null;
  /** Caller's own recorded user-agent, or null. */
  userAgent: string | null;
};

/** Machine-readable account export payload (GDPR Art. 15/20). */
export type AccountExport = {
  /** Caller identity (id, name, email). */
  profile: Whoami;
  /** Team memberships (no shared project/task content). */
  memberships: AccountExportMembership[];
  /** The caller's own legal acceptance evidence. */
  legalAcceptances: AccountExportAcceptance[];
  /** ISO timestamp the export was produced. */
  exportedAt: string;
};

/**
 * Assemble the caller's own account data for a machine-readable export.
 * Scoped to profile, team memberships, and the caller's own legal
 * acceptances — every read runs under the caller's RLS GUC and is outer-
 * scoped to `userId`. Shared project/task/note content held in common with
 * other members is deliberately excluded so the export never discloses
 * another tenant's data.
 *
 * @param userId - Verified caller user id from the session.
 * @returns The caller's export payload.
 * @throws Error when no profile row resolves for the caller.
 */
export async function exportAccountData(
  userId: string,
): Promise<AccountExport> {
  const [profileRaw, orgsRaw, acceptancesRaw] = await withUserContextRead(
    userId,
    (read) => [
      read.execute(
        sql`SELECT user_id, name, email FROM public.current_user_profile()`,
      ),
      read.execute(
        sql`SELECT org_id, member_role, member_created_at FROM public.current_user_orgs()`,
      ),
      read.execute(
        sql`SELECT document_type, document_version, accepted_at, ip_address, user_agent
            FROM public.legal_acceptances
            WHERE user_id = ${userId}::uuid
            ORDER BY accepted_at ASC`,
      ),
    ],
  );
  const [profileRow] = normalizeExecuteResult<{
    user_id: string;
    name: string;
    email: string;
  }>(profileRaw);
  if (!profileRow) {
    throw new Error(`exportAccountData: no profile row for caller ${userId}`);
  }
  const orgs = normalizeExecuteResult<{
    org_id: string;
    member_role: string;
    member_created_at: Date | string;
  }>(orgsRaw);
  const acceptances = normalizeExecuteResult<{
    document_type: string;
    document_version: string;
    accepted_at: Date | string;
    ip_address: string | null;
    user_agent: string | null;
  }>(acceptancesRaw);
  return {
    profile: {
      userId: profileRow.user_id,
      name: profileRow.name,
      email: profileRow.email,
    },
    memberships: orgs.map((o) => ({
      organizationId: o.org_id,
      role: o.member_role,
      createdAt: toDate(o.member_created_at).toISOString(),
    })),
    legalAcceptances: acceptances.map((a) => ({
      documentType: a.document_type,
      documentVersion: a.document_version,
      acceptedAt: toDate(a.accepted_at).toISOString(),
      ipAddress: a.ip_address,
      userAgent: a.user_agent,
    })),
    exportedAt: new Date().toISOString(),
  };
}
