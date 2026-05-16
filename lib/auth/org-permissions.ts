import "server-only";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Check whether the caller can administer the named team. Delegates to
 * Better Auth's `/organization/has-permission` API, which reads the
 * caller's role from `neon_auth.member` for the supplied `organizationId`
 * and consults the active access-control policy. Returns `false` (never
 * throws) so callers can collapse the result into a typed `forbidden`
 * failure.
 *
 * Probes `invitation:create` — both `owner` and `admin` hold this by
 * default; plain `member` does not. Compatible with the custom roles
 * configured via the organization plugin's `roles` option (MYMR-69) since
 * those preserve `invitation:create` in the admin/owner statements.
 *
 * Non-members of the supplied team surface as `false` — BA throws
 * `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` which is caught here. So
 * callers can safely pass an arbitrary `organizationId` from a request
 * body — the check is properly scoped to the target team.
 *
 * @param organizationId - Target team UUID. Required: the team scope is
 *   never inferred from the caller's session.
 * @returns True when the caller may invite/cancel/update against the target team.
 */
export async function isOrgAdmin(organizationId: string): Promise<boolean> {
  try {
    const reqHeaders = await headers();
    const result = await auth.api.hasPermission({
      headers: reqHeaders,
      body: {
        organizationId,
        permissions: { invitation: ["create"] },
      },
    });
    return result.success === true;
  } catch (err) {
    const code = (err as { body?: { code?: string } } | null)?.body?.code;
    if (code === "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION") return false;
    console.error("isOrgAdmin failed", { organizationId, err });
    throw err;
  }
}

/**
 * Check whether the caller is the owner of the named team. Probes
 * `organization:delete`, which only the `owner` role holds in BA's default
 * ACL. Use for actions stricter than admin: deleting the team and
 * promoting another member to owner.
 *
 * BA's `hasPermission` looks up the caller's `member` row for the supplied
 * `organizationId` and checks that role. Non-members surface as `false`
 * because BA throws `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`, which is
 * caught here. So callers can safely pass an arbitrary `organizationId`
 * from a request body — the check is properly scoped to the target team.
 *
 * @param organizationId - Target team UUID. Required: the team scope is
 *   never inferred from the caller's session.
 * @returns True when the caller is the owner of the target team.
 */
export async function isOrgOwner(organizationId: string): Promise<boolean> {
  try {
    const reqHeaders = await headers();
    const result = await auth.api.hasPermission({
      headers: reqHeaders,
      body: {
        organizationId,
        permissions: { organization: ["delete"] },
      },
    });
    return result.success === true;
  } catch (err) {
    const code = (err as { body?: { code?: string } } | null)?.body?.code;
    if (code === "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION") return false;
    console.error("isOrgOwner failed", { organizationId, err });
    throw err;
  }
}
