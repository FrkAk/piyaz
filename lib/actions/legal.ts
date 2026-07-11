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
import {
  getDpaAcceptance,
  listOutstandingReconsent,
  recordAcceptance,
} from "@/lib/data/legal";

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
    organizationId: parsed.data.organizationId,
  });

  const state = await getDpaAcceptance(userId, parsed.data.organizationId);
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
 * Record the caller's re-acceptance of every outstanding personal legal
 * document (terms, privacy). Takes no client input: the server derives the
 * outstanding set via `listOutstandingReconsent`, so a forged document list
 * cannot mark anything accepted. One `legal_acceptances` row per outstanding
 * document, version pinned by `recordAcceptance`. Idempotent: with nothing
 * outstanding (already accepted in another tab) it succeeds without writing.
 *
 * @returns Discriminated result; `ok` once the caller is current on every
 *   personal document.
 */
export async function acceptUpdatedLegalAction(): Promise<TeamActionResult> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }

  const limit = await checkActionRateLimit(
    {
      action: "legal.reconsent.accept",
      windowSeconds: 60,
      perUserMax: 5,
      perIpMax: 10,
    },
    userId,
  );
  if (!limit.ok) return teamFail("rate_limited");

  const outstanding = await listOutstandingReconsent(userId);
  if (outstanding.length === 0) return { ok: true };

  const h = await headers();
  const context = {
    ipAddress: clientIpFromHeaders(h),
    userAgent: h.get("user-agent"),
  };
  for (const documentType of outstanding) {
    await recordAcceptance(userId, documentType, context);
  }
  return { ok: true };
}

/**
 * Read the caller's own current-version DPA acceptance state for one team. No
 * owner gate: it reads only the caller's rows under RLS. The client calls it
 * in the owner branch to decide between the accept control and the accepted
 * state.
 *
 * @param input - `{ organizationId }` naming the team whose state is read.
 * @returns Discriminated result; `data` is the acceptance state, or `null` when
 *   the caller has not accepted the current version for that team.
 */
export async function getDpaAcceptanceAction(input: {
  organizationId: string;
}): Promise<TeamActionResult<DpaAcceptanceState | null>> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(dpaAcceptSchema, input);
  if (!parsed.ok) return parsed;

  const state = await getDpaAcceptance(userId, parsed.data.organizationId);
  return {
    ok: true,
    data: state
      ? { version: state.version, acceptedAt: state.acceptedAt.toISOString() }
      : null,
  };
}
