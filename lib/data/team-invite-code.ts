import "server-only";

import { eq, sql } from "drizzle-orm";
import { db, serviceRoleDb } from "@/lib/db";
import type { AuthContext } from "@/lib/auth/context";
import { executeRaw } from "@/lib/db/raw";
import { withUserContext } from "@/lib/db/rls";
import { teamInviteCodes } from "@/lib/db/team-schema";

/** Full invite-code row, inferred from the schema. */
export type InviteCodeRow = typeof teamInviteCodes.$inferSelect;

/** Days a freshly issued or rotated invite code stays valid. */
const INVITE_CODE_TTL_DAYS = 7;

/**
 * SQL expression for a fresh code's expiry, computed off the database
 * clock so it is immune to app/server clock skew. Applied on both create
 * and rotate so no code is ever open-ended.
 *
 * @returns A `timestamptz` SQL expression `INVITE_CODE_TTL_DAYS` days ahead.
 */
function inviteCodeExpiresAt() {
  return sql`NOW() + (${INVITE_CODE_TTL_DAYS} * INTERVAL '1 day')`;
}

/**
 * Look up the existing invite-code row for a team.
 *
 * Takes a branded `AuthContext` rather than a raw user id so the caller
 * cannot accidentally forward a request-body field as the GUC identity.
 * The RLS policy's admin/owner write predicate is evaluated under
 * `ctx.userId`; for read calls the member SELECT policy covers any team
 * member.
 *
 * @param ctx - Verified caller context.
 * @param organizationId - UUID of the team.
 * @returns The row, or null when the team has no code yet.
 */
export async function findTeamInviteCode(
  ctx: AuthContext,
  organizationId: string,
): Promise<InviteCodeRow | null> {
  return withUserContext(ctx.userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(teamInviteCodes)
      .where(eq(teamInviteCodes.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  });
}

/** Inputs for creating a fresh invite code row. */
export type CreateInviteCodeInput = {
  organizationId: string;
  code: string;
};

/**
 * Insert a new invite-code row. Caller supplies the generated code value.
 * Surfaces the underlying driver error (notably `23505` on the org_id
 * UNIQUE) so the caller can run its retry-as-lookup compensation.
 *
 * `createdBy` and the GUC identity both come from `ctx.userId` — a branded
 * value the auth layer minted from `requireSession()`. The action layer
 * gates with `isOrgAdmin(organizationId)`, and the RESTRICTIVE write
 * policy enforces the same predicate at the DB. `expiresAt` is set so the
 * code is time-bounded from creation.
 *
 * @param ctx - Verified caller context.
 * @param input - Team UUID and generated code.
 * @returns The inserted row.
 */
export async function createTeamInviteCode(
  ctx: AuthContext,
  input: CreateInviteCodeInput,
): Promise<InviteCodeRow> {
  return withUserContext(ctx.userId, async (tx) => {
    const [row] = await tx
      .insert(teamInviteCodes)
      .values({
        organizationId: input.organizationId,
        code: input.code,
        createdBy: ctx.userId,
        expiresAt: inviteCodeExpiresAt(),
      })
      .returning();
    return row;
  });
}

/** Inputs for rotating a team's invite code. */
export type RotateInviteCodeInput = {
  organizationId: string;
  newCode: string;
};

/**
 * Rotate the team's existing code: replace `code`, reset `use_count`, clear
 * `revoked_at`, and refresh `expires_at`. Old codes stop working immediately
 * because lookups are by `code` (UNIQUE).
 *
 * @param ctx - Verified caller context.
 * @param input - Team UUID and freshly generated code.
 * @returns The updated row, or null when the team has no row to update.
 */
export async function rotateTeamInviteCode(
  ctx: AuthContext,
  input: RotateInviteCodeInput,
): Promise<InviteCodeRow | null> {
  return withUserContext(ctx.userId, async (tx) => {
    const [row] = await tx
      .update(teamInviteCodes)
      .set({
        code: input.newCode,
        useCount: 0,
        revokedAt: null,
        expiresAt: inviteCodeExpiresAt(),
        updatedAt: sql`NOW()`,
      })
      .where(eq(teamInviteCodes.organizationId, input.organizationId))
      .returning();
    return row ?? null;
  });
}

/**
 * Mark the team's invite code as revoked. Subsequent join attempts fail.
 *
 * @param ctx - Verified caller context.
 * @param organizationId - UUID of the team.
 * @returns The updated row, or null when the team has no row to revoke.
 */
export async function revokeTeamInviteCode(
  ctx: AuthContext,
  organizationId: string,
): Promise<InviteCodeRow | null> {
  return withUserContext(ctx.userId, async (tx) => {
    const [row] = await tx
      .update(teamInviteCodes)
      .set({ revokedAt: sql`NOW()`, updatedAt: sql`NOW()` })
      .where(eq(teamInviteCodes.organizationId, organizationId))
      .returning();
    return row ?? null;
  });
}

/** Reservation handle returned by {@link reserveInviteCodeSlot}. */
export type InviteCodeReservation = {
  id: string;
  orgId: string;
  defaultRole: "member" | "admin";
};

/**
 * Atomically reserve a slot on an invite code: increments `use_count` if
 * the code is non-revoked, non-expired, and below `max_uses`. Records the
 * caller's `userId` in `reserved_by` so the matching release can confirm
 * the same caller before mutating the slot. Returns the row's
 * `{id, orgId, defaultRole}` on success, null when the code is invalid,
 * exhausted, or the caller's session identity does not match `ctx.userId`.
 *
 * Anti-enumeration: a null result hides which validity guard failed.
 *
 * Trust boundary: the SDF binds `p_user_id` to the session's `app.user_id`
 * GUC, so the wrapper must enter through `withUserContext`. Calling on a
 * bare pool leaves the GUC unset and the SDF rejects every input.
 *
 * @param ctx - Verified caller context.
 * @param code - Raw invite code string (already shape-validated).
 * @returns Reservation handle, or null on failure.
 */
export async function reserveInviteCodeSlot(
  ctx: AuthContext,
  code: string,
): Promise<InviteCodeReservation | null> {
  return withUserContext(ctx.userId, async (tx) => {
    const rows = await executeRaw<{
      id: string;
      organization_id: string;
      default_role: "member" | "admin";
    }>(
      tx,
      sql`SELECT id, organization_id, default_role FROM public.reserve_team_invite_code_slot(${code}, ${ctx.userId}::uuid)`,
    );
    const reserved = rows[0];
    if (!reserved) return null;
    return {
      id: reserved.id,
      orgId: reserved.organization_id,
      defaultRole: reserved.default_role,
    };
  });
}

/**
 * Finalize a reservation after the downstream membership add resolves.
 * Caller passes the explicit outcome — no server-side state inference.
 *
 * - `succeeded = true`: clears `reserved_until` + `reserved_by`, keeps
 *   `use_count`. The slot is consumed.
 * - `succeeded = false`: decrements `use_count` and clears both
 *   `reserved_until` and `reserved_by`. The slot is freed.
 *
 * The SDF gates on `reserved_by = userId`; a mismatch returns false and
 * is logged. Caller invokes this exactly once per reservation, on both
 * success and failure paths of the addMember call.
 *
 * @param userId - Authenticated caller's user id (must match `reserved_by`).
 * @param id - UUID of the invite-code row whose slot was reserved.
 * @param succeeded - Whether the downstream membership add succeeded.
 */
export async function releaseInviteCodeSlot(
  userId: string,
  id: string,
  succeeded: boolean,
): Promise<void> {
  // Bare `db` (no withUserContext frame) is intentional: the SDF takes
  // `p_user_id` as an explicit argument and gates on `reserved_by`, not on
  // the `app.user_id` GUC. Routing through withUserContext would only
  // add a wasted SET LOCAL roundtrip.
  const rows = await executeRaw<{ release_team_invite_code_slot: boolean }>(
    db,
    sql`SELECT public.release_team_invite_code_slot(${id}::uuid, ${userId}::uuid, ${succeeded})`,
  );
  if (!rows[0]?.release_team_invite_code_slot) {
    console.error("[invite-code] release skipped: caller binding mismatch", {
      reservationId: id,
      userId,
      succeeded,
    });
  }
}

/** Diagnostic outcome categories. */
export type InviteCodeDiagnosis =
  | "not_found"
  | "revoked"
  | "expired"
  | "exhausted"
  | "unknown";

/**
 * Best-effort diagnostic for ops triage when a code lookup fails. NEVER
 * surfaced to end users — anti-enumeration. Catches all errors so a
 * diagnostic miss never disrupts the calling action.
 *
 * Routes through `serviceRoleDb`; the underlying `public.lookup_team_invite_code`
 * SDF is EXECUTE-restricted to `service_role` so an `app_user` session cannot
 * enumerate code validity at scale. The user-facing rate limit lives in the
 * calling action layer.
 *
 * @param code - Raw invite code string.
 * @returns Classification of why the code is invalid.
 */
export async function diagnoseTeamInviteCode(
  code: string,
): Promise<InviteCodeDiagnosis> {
  try {
    const rows = await executeRaw<{
      revoked_at: Date | string | null;
      expires_at: Date | string | null;
      max_uses: number | null;
      use_count: number;
    }>(
      serviceRoleDb,
      sql`SELECT revoked_at, expires_at, max_uses, use_count FROM public.lookup_team_invite_code(${code})`,
    );
    const row = rows[0];
    if (!row) return "not_found";
    if (row.revoked_at) return "revoked";
    if (row.expires_at) {
      const expiresAtMs =
        row.expires_at instanceof Date
          ? row.expires_at.getTime()
          : new Date(row.expires_at).getTime();
      if (expiresAtMs <= Date.now()) return "expired";
    }
    if (row.max_uses !== null && row.use_count >= row.max_uses)
      return "exhausted";
    return "unknown";
  } catch (err) {
    console.error("[invite-code] diagnose failed:", err);
    return "unknown";
  }
}
