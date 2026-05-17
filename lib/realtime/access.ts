import "server-only";
import {
  listOrgProjectIds,
  listOrgProjectIdsAsAdmin,
} from "@/lib/data/project";
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
      const projectIds = await listOrgProjectIds(userId, orgId);
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
 *      mutations don't leak event timing to them.
 *   2. Drop every `task:*` sub for the user (bulk, regardless of which
 *      org the task belongs to). Without this, a removed-but-still-
 *      connected member continues to receive `{ kind: "task", ... }`
 *      events for org-Y tasks they previously fetched until the 10-min
 *      TTL expires. Re-registration on the next accessible-task fetch is
 *      free, so a precise filter on the revoked org's task ids would be
 *      extra DB cost for no functional benefit.
 *   3. Skipped when the user has no live SSE connection — `detach`
 *      already cleared the sub map when their last tab closed.
 *   4. Dispatch `project-list:<userId>` so their home grid refetches with
 *      the now-shrunken accessible scope.
 *
 * Non-throwing for the same reason as {@link grantOrgAccess}.
 *
 * Uses the admin-scoped project list: `afterRemoveMember` fires after the
 * member row is gone, so the user-scoped `listOrgProjectIds(userId, orgId)`
 * would return `[]` and silently skip every `unregister`.
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
      const projectIds = await listOrgProjectIdsAsAdmin(orgId);
      for (const id of projectIds) {
        broker.unregister(userId, `project:${id}`);
      }
      broker.clearTaskSubs(userId);
    }
    emitProjectListForUser(userId, orgId);
  } catch (err) {
    console.error("[realtime] revokeOrgAccess failed:", err);
  }
}
