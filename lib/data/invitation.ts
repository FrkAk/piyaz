import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitation } from "@/lib/db/auth-schema";

/**
 * Fetch the organization id for an invitation. Used by the cancel-invite
 * action to scope the admin check to the invitation's own team.
 *
 * @param invitationId - UUID of the invitation.
 * @returns The organization id, or null if no row matches.
 */
export async function findInvitationOrgId(
  invitationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: invitation.organizationId })
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1);
  return row?.organizationId ?? null;
}
