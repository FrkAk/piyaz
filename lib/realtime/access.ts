import "server-only";
import { listOrgProjectIds } from "@/lib/data/project";
import { broker } from "@/lib/realtime/broker";
import { emitProjectListForUser } from "@/lib/realtime/events";

/**
 * Bring a freshly-added member's realtime view into line with their new
 * access:
 *   1. Register `project:<id>` subs on every project in the org so live
 *      mutations reach them — but only if the user already holds at least
 *      one SSE connection. Offline users get fresh subs on their next
 *      connect (the `/api/events` route hydrates from scratch), so adding
 *      subs eagerly would just leak entries that no one is listening on.
 *   2. Dispatch `project-list:<userId>` so their home grid refetches and
 *      picks up the newly accessible projects.
 *
 * Non-throwing: the org `addMember` flow already committed the membership
 * row — realtime delivery is a side effect that must not fail the API call.
 *
 * @param userId - The newly added user.
 * @param orgId - The team they joined.
 */
export async function grantOrgAccess(
  userId: string,
  orgId: string,
): Promise<void> {
  try {
    if (broker.hasConnections(userId)) {
      const projectIds = await listOrgProjectIds(orgId);
      for (const id of projectIds) {
        broker.register(userId, `project:${id}`);
      }
    }
    emitProjectListForUser(userId, orgId);
  } catch (err) {
    console.error("[realtime] grantOrgAccess failed:", err);
  }
}

/**
 * Cut a departing member off from realtime updates for the org's projects:
 *   1. Unregister every `project:<id>` sub for that user so subsequent
 *      mutations don't leak event timing to them. Skipped when the user has
 *      no live SSE connection — `detach` already cleared the sub map when
 *      their last tab closed, or the subs never existed.
 *   2. Dispatch `project-list:<userId>` so their home grid refetches with
 *      the now-shrunken accessible scope. This is the fix for the stale
 *      304 on `/api/projects` after team revocation: without it, the
 *      project-list validator (`getProjectListMaxUpdatedAt`) can move
 *      backwards as access shrinks, the conditional GET returns 304, and
 *      the client keeps stale projects in the home grid.
 *
 * Non-throwing for the same reason as {@link grantOrgAccess}.
 *
 * @param userId - The departing user.
 * @param orgId - The team they left.
 */
export async function revokeOrgAccess(
  userId: string,
  orgId: string,
): Promise<void> {
  try {
    if (broker.hasConnections(userId)) {
      const projectIds = await listOrgProjectIds(orgId);
      for (const id of projectIds) {
        broker.unregister(userId, `project:${id}`);
      }
    }
    emitProjectListForUser(userId, orgId);
  } catch (err) {
    console.error("[realtime] revokeOrgAccess failed:", err);
  }
}
