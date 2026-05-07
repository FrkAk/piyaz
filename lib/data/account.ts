import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@/lib/db/auth-schema";

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
 * @param userId - Owner of the artifacts to remove.
 * @param orgId - Organization the artifacts pointed at.
 */
export async function clearOrgMembershipArtifacts(
  userId: string,
  orgId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
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
  });
}
