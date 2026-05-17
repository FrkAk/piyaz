import "server-only";
import { sql } from "drizzle-orm";
import { isUuid } from "@/lib/auth/authorization";
import { executeRaw } from "@/lib/db/raw";
import { withUserContext } from "@/lib/db/rls";

/**
 * Boolean predicate: caller is a member of the invitation's org AND
 * the supplied `expectedOrgId` matches the invitation's own
 * `organizationId`. Routed through `is_caller_in_invitation_org` so
 * `app_user` can resolve `neon_auth.invitation` without disclosing the
 * invitation→org linkage to non-members.
 *
 * @param userId - Authenticated caller's user id (UUID).
 * @param invitationId - UUID of the invitation.
 * @param expectedOrgId - UUID the caller already believes owns the
 *   invitation. Anti-enumeration: the SDF refuses to confirm anything
 *   unless this matches the row's actual organizationId.
 * @returns True iff both predicates hold; false otherwise.
 */
export async function isCallerInInvitationOrg(
  userId: string,
  invitationId: string,
  expectedOrgId: string,
): Promise<boolean> {
  if (!isUuid(invitationId) || !isUuid(expectedOrgId)) return false;
  return withUserContext(userId, async (tx) => {
    const rows = await executeRaw<{ ok: boolean }>(
      tx,
      sql`SELECT public.is_caller_in_invitation_org(${invitationId}::uuid, ${expectedOrgId}::uuid) AS ok`,
    );
    return rows[0]?.ok === true;
  });
}
