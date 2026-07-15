"use server";

import { headers } from "next/headers";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { requireLegalConsent } from "@/lib/auth/consent";
import { requireSession } from "@/lib/auth/session";
import { isOrgAdmin } from "@/lib/auth/org-permissions";
import {
  mapBetterAuthError,
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from "@/lib/actions/team-errors";
import {
  toInvitationView,
  type BetterAuthInvitationRow,
  type InvitationView,
} from "@/lib/actions/team-invitations-map";
import { isCallerInInvitationOrg } from "@/lib/data/invitation";
import { lookupUserNames } from "@/lib/data/membership";
import { checkActionRateLimit } from "@/lib/actions/rate-limit-action";

/**
 * Input schema for {@link cancelInvitationAction}. Requires the caller
 * to supply both the invitation id and the organization id they believe
 * owns it so the action can verify the linkage without disclosing it.
 */
const cancelSchema = z.object({
  invitationId: z.uuid(),
  organizationId: z.uuid(),
});

const listInvitationsSchema = z.object({
  organizationId: z.uuid(),
});

/**
 * List pending invitations for the supplied team. Filters out
 * already-accepted, rejected, and expired rows so the admin only sees
 * actionable items.
 *
 * Inviter names are resolved via a single batched user lookup since BA
 * returns only `inviterId` on the listInvitations row. A transient
 * name-lookup failure degrades gracefully to the 'Unknown' fallback
 * rather than collapsing the whole list.
 *
 * Defense-in-depth: BA's `listInvitations` endpoint only checks team
 * membership, NOT role. Without the explicit `isOrgAdmin(organizationId)`
 * gate here a regular member who calls the action directly (server-action
 * POST from the browser) could harvest invitee emails for any team they
 * belong to. The gate is target-scoped so admins of team T can list T's
 * invitations even when their session is active on team U.
 *
 * @param input - `{ organizationId }` of the team to list invitations for.
 * @returns Discriminated result; `data` is the pending list (newest first).
 */
export async function listPendingInvitationsAction(input: {
  organizationId: string;
}): Promise<TeamActionResult<InvitationView[]>> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  await requireLegalConsent(userId);

  const parsed = parseOrFail(listInvitationsSchema, input);
  if (!parsed.ok) return parsed;

  let isAdmin: boolean;
  try {
    isAdmin = await isOrgAdmin(parsed.data.organizationId);
  } catch (err) {
    console.error("listPendingInvitationsAction: isOrgAdmin failed", {
      organizationId: parsed.data.organizationId,
      err,
    });
    return teamFail("unknown");
  }
  if (!isAdmin) return teamFail("forbidden");

  let raw: BetterAuthInvitationRow[];
  try {
    const result = await auth.api.listInvitations({
      query: { organizationId: parsed.data.organizationId },
      headers: await headers(),
    });
    raw = (result ?? []) as BetterAuthInvitationRow[];
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("listPendingInvitationsAction failed", err);
    }
    return teamFail(code);
  }

  const now = Date.now();
  const pending = raw.filter((row) => {
    if (row.status !== "pending") return false;
    const expiresAt =
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
    return expiresAt.getTime() > now;
  });

  if (pending.length === 0) return { ok: true, data: [] };

  const inviterIds = Array.from(new Set(pending.map((row) => row.inviterId)));
  let nameById: Map<string, string>;
  try {
    nameById = await lookupUserNames(userId, inviterIds);
  } catch (err) {
    console.error("listPendingInvitationsAction: lookupUserNames failed", {
      organizationId: parsed.data.organizationId,
      err,
    });
    nameById = new Map();
  }

  const data = pending
    .map((row) =>
      toInvitationView(row, nameById.get(row.inviterId) ?? "Unknown"),
    )
    .sort((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());

  return { ok: true, data };
}

/**
 * Cancel a pending invitation. BA enforces `invitation:cancel`
 * (admin+owner) at the endpoint and scopes by the invitation's own
 * organization, so cross-team cancels are rejected.
 *
 * Defense-in-depth: the caller passes the `organizationId` they already
 * believe owns the invitation; we route through
 * `isCallerInInvitationOrg` which returns a boolean predicate without
 * disclosing the invitation→org linkage, then run
 * `isOrgAdmin(organizationId)` against the same id. A mismatched or
 * non-existent invitation surfaces a typed `not_found`.
 *
 * @param input - `{ invitationId, organizationId }` to cancel.
 * @returns Discriminated result.
 */
export async function cancelInvitationAction(input: {
  invitationId: string;
  organizationId: string;
}): Promise<TeamActionResult> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  await requireLegalConsent(userId);

  const parsed = parseOrFail(cancelSchema, input);
  if (!parsed.ok) return parsed;

  const limit = await checkActionRateLimit(
    {
      action: "team.invite_cancel",
      windowSeconds: 60,
      perUserMax: 20,
      perIpMax: 40,
    },
    userId,
  );
  if (!limit.ok) return teamFail("rate_limited");

  let inOrg: boolean;
  try {
    inOrg = await isCallerInInvitationOrg(
      userId,
      parsed.data.invitationId,
      parsed.data.organizationId,
    );
  } catch (err) {
    console.error("cancelInvitationAction: isCallerInInvitationOrg failed", {
      invitationId: parsed.data.invitationId,
      organizationId: parsed.data.organizationId,
      err,
    });
    return teamFail("unknown");
  }
  if (!inOrg) return teamFail("not_found");

  let isAdmin: boolean;
  try {
    isAdmin = await isOrgAdmin(parsed.data.organizationId);
  } catch (err) {
    console.error("cancelInvitationAction: isOrgAdmin failed", {
      organizationId: parsed.data.organizationId,
      err,
    });
    return teamFail("unknown");
  }
  if (!isAdmin) return teamFail("forbidden");

  try {
    await auth.api.cancelInvitation({
      body: { invitationId: parsed.data.invitationId },
      headers: await headers(),
    });
    return { ok: true };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("cancelInvitationAction failed", err);
    }
    return teamFail(code);
  }
}

/**
 * Resend a pending invitation's email. The pending row is resolved
 * server-side and re-issued through BA's `createInvitation` with
 * `resend: true`, which refreshes `expiresAt` on the existing row and
 * refires `sendInvitationEmail` without creating a duplicate — the
 * recipient address and role are never taken from the client, so a stale
 * UI cannot re-invite a canceled row or mail an arbitrary address.
 *
 * Defense-in-depth mirrors {@link cancelInvitationAction}:
 * `isCallerInInvitationOrg` verifies the id linkage without disclosing
 * it (mismatch surfaces as `not_found`), then `isOrgAdmin` gates the
 * role. Canceled, accepted, and expired rows also map to `not_found`.
 *
 * @param input - `{ invitationId, organizationId }` to resend.
 * @returns Discriminated result.
 */
export async function resendInvitationAction(input: {
  invitationId: string;
  organizationId: string;
}): Promise<TeamActionResult> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }
  await requireLegalConsent(userId);

  const parsed = parseOrFail(cancelSchema, input);
  if (!parsed.ok) return parsed;

  const limit = await checkActionRateLimit(
    {
      action: "team.invite_resend",
      windowSeconds: 60,
      perUserMax: 10,
      perIpMax: 20,
    },
    userId,
  );
  if (!limit.ok) return teamFail("rate_limited");

  let inOrg: boolean;
  try {
    inOrg = await isCallerInInvitationOrg(
      userId,
      parsed.data.invitationId,
      parsed.data.organizationId,
    );
  } catch (err) {
    console.error("resendInvitationAction: isCallerInInvitationOrg failed", {
      invitationId: parsed.data.invitationId,
      organizationId: parsed.data.organizationId,
      err,
    });
    return teamFail("unknown");
  }
  if (!inOrg) return teamFail("not_found");

  let isAdmin: boolean;
  try {
    isAdmin = await isOrgAdmin(parsed.data.organizationId);
  } catch (err) {
    console.error("resendInvitationAction: isOrgAdmin failed", {
      organizationId: parsed.data.organizationId,
      err,
    });
    return teamFail("unknown");
  }
  if (!isAdmin) return teamFail("forbidden");

  let row: BetterAuthInvitationRow | undefined;
  try {
    const result = await auth.api.listInvitations({
      query: { organizationId: parsed.data.organizationId },
      headers: await headers(),
    });
    const rows = (result ?? []) as BetterAuthInvitationRow[];
    row = rows.find((r) => r.id === parsed.data.invitationId);
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("resendInvitationAction: listInvitations failed", err);
    }
    return teamFail(code);
  }
  if (!row || row.status !== "pending") return teamFail("not_found");
  const expiresAt =
    row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  if (expiresAt.getTime() <= Date.now()) return teamFail("not_found");

  const role =
    row.role === "admin" || row.role === "owner" ? row.role : "member";
  try {
    await auth.api.createInvitation({
      body: {
        email: row.email,
        role,
        organizationId: parsed.data.organizationId,
        resend: true,
      },
      headers: await headers(),
    });
    return { ok: true };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("resendInvitationAction: createInvitation failed", err);
    }
    return teamFail(code);
  }
}
