import "server-only";

import { findMemberRole } from "@/lib/data/membership";
import type { AuthContext } from "@/lib/auth/context";
import {
  roleHasProjectPermission,
  type ProjectAction,
} from "@/lib/auth/permissions";

/**
 * Read the caller's role string for a given organization. Returns the raw
 * `member.role` value (possibly comma-separated for multi-role) or `null`
 * when the caller is not a member of the supplied organization.
 *
 * @param ctx - Resolved auth context.
 * @param organizationId - UUID of the organization to read the role from.
 * @returns Role string or null if the caller has no membership row in that org.
 */
export async function getMemberRole(
  ctx: AuthContext,
  organizationId: string,
): Promise<string | null> {
  return findMemberRole(ctx.userId, organizationId);
}

/**
 * Resolve whether the caller can perform a set of project actions in a
 * given organization. Returns false when no membership row is found.
 *
 * @param ctx - Resolved auth context.
 * @param organizationId - UUID of the organization to evaluate the role against.
 * @param actions - Required project actions (AND-ed).
 * @returns True when the caller's role in that org grants every requested action.
 */
export async function canPerformProjectActions(
  ctx: AuthContext,
  organizationId: string,
  actions: readonly ProjectAction[],
): Promise<boolean> {
  const role = await getMemberRole(ctx, organizationId);
  if (!role) return false;
  return roleHasProjectPermission(role, actions);
}
