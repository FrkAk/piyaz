import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { serviceRoleDb } from "@/lib/db";
import {
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@/lib/db/auth-schema";
import { projects, tasks, taskAssignees } from "@/lib/db/schema";

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
    // mymir wires `consentReferenceId → activeOrganizationId` so the row
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
    // `task_assignees` FK to `neon_auth.user` only cascades on full user
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
