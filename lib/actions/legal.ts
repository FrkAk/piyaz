"use server";

import { headers } from "next/headers";
import { z } from "zod/v4";
import { requireSession } from "@/lib/auth/session";
import { isOrgOwner } from "@/lib/auth/org-permissions";
import {
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from "@/lib/actions/team-errors";
import {
  checkActionRateLimit,
  clientIpFromHeaders,
} from "@/lib/actions/rate-limit-action";
import { getDpaAcceptance, recordAcceptance } from "@/lib/data/legal";

/**
 * Serializable DPA acceptance state. `acceptedAt` is an ISO string so the
 * payload crosses the server-action boundary as plain JSON and stays
 * cache-friendly on the client.
 */
export type DpaAcceptanceState = { version: string; acceptedAt: string };

const dpaAcceptSchema = z.object({
  organizationId: z.uuid(),
});

/**
 * Record the calling owner's acceptance of the DPA for the named team. Writes
 * one `legal_acceptances` row via `recordAcceptance` with `documentType='dpa'`
 * and the version pinned from `LEGAL_VERSIONS.dpa`.
 *
 * Owner-gated on the EXPLICIT `organizationId` (never the session default):
 * `isOrgOwner` returns `false` for admins and plain members, so both are denied
 * with no row written. The write routes through `withUserContext` under the
 * `legal_acceptances_self_access` RLS policy, so `user_id` is not
 * caller-forgeable. Rate-limited like the sibling destructive team actions.
 *
 * @param input - `{ organizationId }` naming the team the owner accepts for.
 * @returns Discriminated result; `data` is the just-written acceptance state so
 *   the client flips to accepted without a second round trip.
 */
export async function recordDpaAcceptanceAction(input: {
  organizationId: string;
}): Promise<TeamActionResult<DpaAcceptanceState>> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(dpaAcceptSchema, input);
  if (!parsed.ok) return parsed;

  const limit = await checkActionRateLimit(
    {
      action: "legal.dpa.accept",
      windowSeconds: 60,
      perUserMax: 5,
      perIpMax: 10,
    },
    userId,
  );
  if (!limit.ok) return teamFail("rate_limited");

  let isOwner: boolean;
  try {
    isOwner = await isOrgOwner(parsed.data.organizationId);
  } catch (err) {
    console.error("recordDpaAcceptanceAction: isOrgOwner failed", {
      organizationId: parsed.data.organizationId,
      err,
    });
    return teamFail("unknown");
  }
  if (!isOwner) return teamFail("forbidden");

  const h = await headers();
  await recordAcceptance(userId, "dpa", {
    ipAddress: clientIpFromHeaders(h),
    userAgent: h.get("user-agent"),
  });

  const state = await getDpaAcceptance(userId);
  if (!state) return teamFail("unknown");
  return {
    ok: true,
    data: {
      version: state.version,
      acceptedAt: state.acceptedAt.toISOString(),
    },
  };
}

/**
 * Read the caller's own current-version DPA acceptance state. No owner gate:
 * it reads only the caller's rows under RLS. The client calls it in the owner
 * branch to decide between the accept control and the accepted state.
 *
 * @returns Discriminated result; `data` is the acceptance state, or `null` when
 *   the caller has not accepted the current version.
 */
export async function getDpaAcceptanceAction(): Promise<
  TeamActionResult<DpaAcceptanceState | null>
> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }

  const state = await getDpaAcceptance(userId);
  return {
    ok: true,
    data: state
      ? { version: state.version, acceptedAt: state.acceptedAt.toISOString() }
      : null,
  };
}
