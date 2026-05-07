import "server-only";

import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { teamInviteCodes } from "@/lib/db/team-schema";

/** Full invite-code row, inferred from the schema. */
export type InviteCodeRow = typeof teamInviteCodes.$inferSelect;

/**
 * Look up the existing invite-code row for a team.
 *
 * @param organizationId - UUID of the team.
 * @returns The row, or null when the team has no code yet.
 */
export async function findTeamInviteCode(
  organizationId: string,
): Promise<InviteCodeRow | null> {
  const [row] = await db
    .select()
    .from(teamInviteCodes)
    .where(eq(teamInviteCodes.organizationId, organizationId))
    .limit(1);
  return row ?? null;
}

/** Inputs for creating a fresh invite code row. */
export type CreateInviteCodeInput = {
  organizationId: string;
  code: string;
  createdBy: string;
};

/**
 * Insert a new invite-code row. Caller supplies the generated code value.
 * Surfaces the underlying driver error (notably `23505` on the org_id
 * UNIQUE) so the caller can run its retry-as-lookup compensation.
 *
 * @param input - Team UUID, generated code, and creator user id.
 * @returns The inserted row.
 */
export async function createTeamInviteCode(
  input: CreateInviteCodeInput,
): Promise<InviteCodeRow> {
  const [row] = await db
    .insert(teamInviteCodes)
    .values({
      organizationId: input.organizationId,
      code: input.code,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

/** Inputs for rotating a team's invite code. */
export type RotateInviteCodeInput = {
  organizationId: string;
  newCode: string;
};

/**
 * Rotate the team's existing code: replace `code`, reset `use_count`, clear
 * `revoked_at`. Old codes stop working immediately because lookups are by
 * `code` (UNIQUE).
 *
 * @param input - Team UUID and freshly generated code.
 * @returns The updated row, or null when the team has no row to update.
 */
export async function rotateTeamInviteCode(
  input: RotateInviteCodeInput,
): Promise<InviteCodeRow | null> {
  const [row] = await db
    .update(teamInviteCodes)
    .set({
      code: input.newCode,
      useCount: 0,
      revokedAt: null,
      updatedAt: sql`NOW()`,
    })
    .where(eq(teamInviteCodes.organizationId, input.organizationId))
    .returning();
  return row ?? null;
}

/**
 * Mark the team's invite code as revoked. Subsequent join attempts fail.
 *
 * @param organizationId - UUID of the team.
 * @returns The updated row, or null when the team has no row to revoke.
 */
export async function revokeTeamInviteCode(
  organizationId: string,
): Promise<InviteCodeRow | null> {
  const [row] = await db
    .update(teamInviteCodes)
    .set({ revokedAt: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(eq(teamInviteCodes.organizationId, organizationId))
    .returning();
  return row ?? null;
}

/** Reservation handle returned by {@link reserveInviteCodeSlot}. */
export type InviteCodeReservation = {
  id: string;
  orgId: string;
  defaultRole: "member" | "admin";
};

/**
 * Atomically reserve a slot on an invite code: increments `use_count` if
 * the code is non-revoked, non-expired, and below `max_uses`. Returns the
 * row's `{id, orgId, defaultRole}` on success, null when the code is
 * invalid or exhausted.
 *
 * Anti-enumeration: a null result hides which validity guard failed.
 *
 * @param code - Raw invite code string (already shape-validated).
 * @returns Reservation handle, or null on failure.
 */
export async function reserveInviteCodeSlot(
  code: string,
): Promise<InviteCodeReservation | null> {
  const [reserved] = await db
    .update(teamInviteCodes)
    .set({
      useCount: sql`${teamInviteCodes.useCount} + 1`,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(teamInviteCodes.code, code),
        isNull(teamInviteCodes.revokedAt),
        or(
          isNull(teamInviteCodes.expiresAt),
          gt(teamInviteCodes.expiresAt, sql`NOW()`),
        ),
        or(
          isNull(teamInviteCodes.maxUses),
          lt(teamInviteCodes.useCount, teamInviteCodes.maxUses),
        ),
      ),
    )
    .returning({
      id: teamInviteCodes.id,
      orgId: teamInviteCodes.organizationId,
      defaultRole: teamInviteCodes.defaultRole,
    });
  return reserved ?? null;
}

/**
 * Decrement a reserved slot when the downstream membership add fails.
 * Saga compensation — never drops below zero.
 *
 * @param id - UUID of the invite-code row whose slot was reserved.
 */
export async function releaseInviteCodeSlot(id: string): Promise<void> {
  await db
    .update(teamInviteCodes)
    .set({
      useCount: sql`GREATEST(${teamInviteCodes.useCount} - 1, 0)`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(teamInviteCodes.id, id));
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
 * @param code - Raw invite code string.
 * @returns Classification of why the code is invalid.
 */
export async function diagnoseTeamInviteCode(
  code: string,
): Promise<InviteCodeDiagnosis> {
  try {
    const [row] = await db
      .select({
        revokedAt: teamInviteCodes.revokedAt,
        expiresAt: teamInviteCodes.expiresAt,
        maxUses: teamInviteCodes.maxUses,
        useCount: teamInviteCodes.useCount,
      })
      .from(teamInviteCodes)
      .where(eq(teamInviteCodes.code, code))
      .limit(1);
    if (!row) return "not_found";
    if (row.revokedAt) return "revoked";
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return "expired";
    if (row.maxUses !== null && row.useCount >= row.maxUses) return "exhausted";
    return "unknown";
  } catch {
    return "unknown";
  }
}
