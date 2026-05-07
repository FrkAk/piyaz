"use server";

import { headers } from "next/headers";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";
import { requireSession } from "@/lib/auth/session";
import { clearOrgMembershipArtifacts } from "@/lib/data/account";
import { isOrgAdmin, isOrgOwner } from "@/lib/auth/org-permissions";
import {
  mapBetterAuthError,
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from "@/lib/actions/team-errors";
import {
  demoteMemberWithGuard,
  findMemberById,
  previewTeamDelete,
} from "@/lib/data/membership";
import { parseMemberRoles } from "@/lib/auth/permissions";
import {
  RESERVED_SLUGS,
  SLUG_MAX,
  SLUG_MIN,
  SLUG_PATTERN,
  TEAM_NAME_MAX,
} from "@/lib/team/slug-rules";

const createTeamSchema = z.object({
  name: z.string().trim().min(1, "Team name is required").max(TEAM_NAME_MAX),
  slug: z
    .string()
    .trim()
    .min(SLUG_MIN)
    .max(SLUG_MAX)
    .regex(SLUG_PATTERN, "Slug must be lowercase alphanumeric with hyphens")
    .refine((s) => !RESERVED_SLUGS.has(s), {
      message: "That URL slug is reserved. Try a different one.",
    }),
});

/**
 * Lenient runtime guard for `auth.api.acceptInvitation`'s response. BA
 * doesn't export a stable result type for this endpoint, so we parse
 * the only field we actually consume. Mismatches surface as `unknown`
 * rather than throwing through the call site.
 */
const acceptInvitationResponseSchema = z.object({
  invitation: z.object({
    organizationId: z.uuid(),
  }),
});

const memberRoleSchema = z.enum(["member", "admin", "owner"]);
const uuidSchema = z.uuid();
const emailSchema = z.email();

const inviteMemberSchema = z.object({
  organizationId: uuidSchema,
  email: emailSchema,
  role: memberRoleSchema.optional(),
});

const removeMemberSchema = z.object({
  organizationId: uuidSchema,
  memberIdOrEmail: z.string().trim().min(1),
});

const updateMemberRoleSchema = z.object({
  organizationId: uuidSchema,
  memberId: uuidSchema,
  role: memberRoleSchema,
});

const leaveTeamSchema = z.object({
  organizationId: uuidSchema,
});

const acceptInvitationSchema = z.object({
  invitationId: uuidSchema,
});

const slugSchema = z
  .string()
  .trim()
  .min(SLUG_MIN)
  .max(SLUG_MAX)
  .regex(SLUG_PATTERN, "Slug must be lowercase alphanumeric with hyphens")
  .refine((s) => !RESERVED_SLUGS.has(s), {
    message: "That URL slug is reserved. Try a different one.",
  });

const updateTeamSchema = z
  .object({
    organizationId: uuidSchema,
    name: z.string().trim().min(1, "Team name is required").max(TEAM_NAME_MAX).optional(),
    slug: slugSchema.optional(),
  })
  .refine((data) => data.name !== undefined || data.slug !== undefined, {
    message: "Provide at least one field to update",
  });

const deleteTeamSchema = z.object({
  organizationId: uuidSchema,
});

/** Convenience: does `role` carry the `owner` grant? */
function roleIncludesOwner(role: string): boolean {
  return parseMemberRoles(role).includes("owner");
}

/**
 * Create a new organization (team) for the signed-in user. The caller is
 * added as `owner` of the new team. The caller does NOT need an existing
 * team membership — this is the bootstrap path used by onboarding.
 *
 * @param input - `{ name, slug }` from the form.
 * @returns Discriminated result; `data.organizationId` on success.
 */
export async function createTeamAction(input: {
  name: string;
  slug: string;
}): Promise<TeamActionResult<{ organizationId: string }>> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(createTeamSchema, input);
  if (!parsed.ok) return parsed;

  try {
    const reqHeaders = await headers();
    const created = await auth.api.createOrganization({
      body: { name: parsed.data.name, slug: parsed.data.slug },
      headers: reqHeaders,
    });
    if (!created) return teamFail("unknown");
    return { ok: true, data: { organizationId: created.id } };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("createTeamAction failed", err);
    }
    return teamFail(code);
  }
}

/**
 * Send an email invitation to join a team. Better Auth enforces the
 * recipient-email check at acceptance time; this action just creates
 * the invitation row and (in the future) hands it to a mailer.
 *
 * Target-scoped: callers always name the destination team, so admins of
 * team T can invite to T regardless of which team their session was last
 * pointed at. The team is never inferred from the session.
 *
 * Defense-in-depth: an explicit `isOrgAdmin(organizationId)` check runs
 * first so the action's authorization does not single-source from BA's
 * error code shape. BA also enforces `invitation:create` (admin+owner)
 * at the endpoint and uses the supplied `body.organizationId` for both
 * the permission check and the underlying insert.
 *
 * @param input - Target org id, recipient email, optional role.
 * @returns Discriminated result.
 */
export async function inviteMemberAction(input: {
  organizationId: string;
  email: string;
  role?: "member" | "admin" | "owner";
}): Promise<TeamActionResult> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(inviteMemberSchema, input);
  if (!parsed.ok) return parsed;

  if (!(await isOrgAdmin(parsed.data.organizationId))) return teamFail("forbidden");

  try {
    const reqHeaders = await headers();
    await auth.api.createInvitation({
      body: {
        email: parsed.data.email,
        role: parsed.data.role ?? "member",
        organizationId: parsed.data.organizationId,
      },
      headers: reqHeaders,
    });
    return { ok: true };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("inviteMemberAction failed", err);
    }
    return teamFail(code);
  }
}

/**
 * Remove a member from the named team. Better Auth fires
 * `afterRemoveMember`, which clears stale OAuth tokens via
 * `clearOrgMembershipArtifacts` — see lib/auth.ts.
 *
 * Layered authorization:
 * 1. `isOrgAdmin(organizationId)` — defense-in-depth so authz does not
 *    single-source from BA's error code shape, and is target-scoped
 *    rather than session-scoped.
 * 2. BA's `removeMember` enforces `member:delete` (admin+owner) at the
 *    endpoint and uses the supplied `body.organizationId` for both the
 *    permission check and the underlying delete (verified against
 *    `better-auth@1.6.x crud-members.mjs`).
 *
 * @param input - Target team and member id-or-email.
 * @returns Discriminated result.
 */
export async function removeMemberAction(input: {
  organizationId: string;
  memberIdOrEmail: string;
}): Promise<TeamActionResult> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(removeMemberSchema, input);
  if (!parsed.ok) return parsed;

  if (!(await isOrgAdmin(parsed.data.organizationId))) return teamFail("forbidden");

  try {
    const reqHeaders = await headers();
    await auth.api.removeMember({
      body: {
        memberIdOrEmail: parsed.data.memberIdOrEmail,
        organizationId: parsed.data.organizationId,
      },
      headers: reqHeaders,
    });
    return { ok: true };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("removeMemberAction failed", err);
    }
    return teamFail(code);
  }
}

/**
 * Change a member's role within the named team.
 *
 * Layered authorization:
 * 1. `isOrgAdmin(organizationId)` — target-scoped defense-in-depth so
 *    authz doesn't single-source from BA's error code shape; the team
 *    scope is the supplied id, never inferred from the session.
 * 2. Cross-team probe rejection — target's `member.organizationId` must
 *    match the supplied `organizationId`. Returns `forbidden` (404-shaped)
 *    so a probe cannot tell membership apart from non-existence.
 * 3. Last-owner guard, atomically held against concurrent demotes — the
 *    re-read of target + owner-count + BA's `updateMemberRole` happen
 *    inside a transaction holding `pg_advisory_xact_lock` keyed on the
 *    team. Two browsers demoting two different owners simultaneously
 *    serialize on this lock, so the second demote sees the first's
 *    committed effect (one owner left) and fails closed. BA's own check
 *    only fires on self-demote; this guard catches the cross-actor case.
 * 4. BA's `updateMemberRole` enforces `member:update` (admin+owner) at
 *    the endpoint plus its own creator-role/last-owner safeguards. Pass
 *    `body.organizationId` so BA scopes the write to the supplied team.
 *
 * BA's UPDATE runs on its own connection (autocommit) inside our tx
 * callback. The advisory lock doesn't block that connection, so there's
 * no deadlock; the lock simply serializes other actions waiting to run
 * the same gate.
 *
 * `member.role` parsing goes through {@link roleIncludesOwner} which
 * accepts both BA's current comma-separated format and a future JSON
 * array, so a serializer change can't silently flip the last-owner
 * guard open.
 *
 * @param input - Target team, member id, and new role.
 * @returns Discriminated result.
 */
export async function updateMemberRoleAction(input: {
  organizationId: string;
  memberId: string;
  role: "member" | "admin" | "owner";
}): Promise<TeamActionResult> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(updateMemberRoleSchema, input);
  if (!parsed.ok) return parsed;

  if (!(await isOrgAdmin(parsed.data.organizationId))) return teamFail("forbidden");

  const preRead = await findMemberById(parsed.data.memberId);
  if (!preRead) return teamFail("not_found");
  if (preRead.organizationId !== parsed.data.organizationId) return teamFail("forbidden");

  const reqHeaders = await headers();
  const outcome = await demoteMemberWithGuard(
    {
      organizationId: parsed.data.organizationId,
      memberId: parsed.data.memberId,
      role: parsed.data.role,
      roleIncludesOwner,
    },
    async () => {
      await auth.api.updateMemberRole({
        body: {
          memberId: parsed.data.memberId,
          role: parsed.data.role,
          organizationId: parsed.data.organizationId,
        },
        headers: reqHeaders,
      });
    },
  );

  if (outcome.kind === "ok") return { ok: true };
  if (outcome.kind === "fail") return teamFail(outcome.code);
  const code = mapBetterAuthError(outcome.err);
  if (code === "unknown") {
    console.error("updateMemberRoleAction failed", outcome.err);
  }
  return teamFail(code);
}

/**
 * Leave the named organization. Better Auth's `leaveOrganization` does NOT
 * fire `afterRemoveMember`, so we call `clearOrgMembershipArtifacts` here
 * directly to wipe OAuth tokens and other-session active-org pointers.
 *
 * @param input - Organization id to leave.
 * @returns Discriminated result.
 */
export async function leaveTeamAction(input: {
  organizationId: string;
}): Promise<TeamActionResult> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail("unauthorized");
  }

  const parsed = parseOrFail(leaveTeamSchema, input);
  if (!parsed.ok) return parsed;

  try {
    const reqHeaders = await headers();
    await auth.api.leaveOrganization({
      body: { organizationId: parsed.data.organizationId },
      headers: reqHeaders,
    });
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("leaveTeamAction failed", err);
    }
    return teamFail(code);
  }

  // Cleanup is best-effort. The user is already out of the org;
  // surfacing a 500 here would be confusing and offer no recovery
  // path. Stale OAuth tokens linger until cron / next prune.
  try {
    await clearOrgMembershipArtifacts(userId, parsed.data.organizationId);
  } catch (err) {
    console.error("leaveTeamAction cleanup failed", {
      err,
      userId,
      orgId: parsed.data.organizationId,
    });
  }
  return { ok: true };
}

/**
 * Accept an emailed invitation by id. Better Auth enforces that the
 * session user's email matches `invitation.email` — wrong-recipient maps
 * to the typed `wrong_recipient` failure code.
 *
 * @param input - Invitation UUID.
 * @returns Discriminated result; `data.organizationId` on success.
 */
export async function acceptEmailInvitationAction(input: {
  invitationId: string;
}): Promise<TeamActionResult<{ organizationId: string }>> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(acceptInvitationSchema, input);
  if (!parsed.ok) return parsed;

  try {
    const reqHeaders = await headers();
    const accepted = await auth.api.acceptInvitation({
      body: { invitationId: parsed.data.invitationId },
      headers: reqHeaders,
    });
    const shape = acceptInvitationResponseSchema.safeParse(accepted);
    if (!shape.success) {
      console.error("acceptEmailInvitationAction unexpected response shape", {
        accepted,
        issues: shape.error.issues,
      });
      return teamFail("unknown");
    }
    const { organizationId } = shape.data.invitation;
    return { ok: true, data: { organizationId } };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("acceptEmailInvitationAction failed", err);
    }
    return teamFail(code);
  }
}

/**
 * Rename a team. BA enforces `organization:update` (admin + owner) at the
 * endpoint; we surface BA's authz rejection as a typed `forbidden` via
 * `mapBetterAuthError`. Either `name` or `slug` (or both) may be provided —
 * the schema rejects an empty payload before we hit BA.
 *
 * Defense-in-depth: explicit `isOrgAdmin(organizationId)` check runs
 * first, scoped to the supplied target team. A regular member or
 * non-member of the target team surfaces a typed `forbidden` before any
 * BA call.
 *
 * BA's `updateOrganization` honors `body.organizationId` for both the
 * permission check and the underlying write — verified against
 * `better-auth@1.6.x crud-org.mjs:199-228`. The supplied team is always
 * the rename target, regardless of any session-level org pointer.
 *
 * @param input - `{ organizationId, name?, slug? }`.
 * @returns Discriminated result.
 */
export async function updateTeamAction(input: {
  organizationId: string;
  name?: string;
  slug?: string;
}): Promise<TeamActionResult> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(updateTeamSchema, input);
  if (!parsed.ok) return parsed;

  if (!(await isOrgAdmin(parsed.data.organizationId))) return teamFail("forbidden");

  const data: { name?: string; slug?: string } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.slug !== undefined) data.slug = parsed.data.slug;

  try {
    await auth.api.updateOrganization({
      body: { data, organizationId: parsed.data.organizationId },
      headers: await headers(),
    });
    return { ok: true };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("updateTeamAction failed", err);
    }
    return teamFail(code);
  }
}

/**
 * Delete a team and cascade every dependent resource. Owner-only — we
 * gate explicitly via `isOrgOwner()` BEFORE calling BA so admins get a
 * predictable `forbidden` failure (BA also rejects, but the upstream
 * check avoids depending on BA's specific error code shape for this
 * destructive action).
 *
 * Side effects (already wired upstream — no work here):
 * - `beforeDeleteOrganization` hook in `lib/auth.ts` clears OAuth
 *   artifacts for every member.
 * - FK `ON DELETE CASCADE` wipes projects → tasks → task_edges,
 *   invitations, team_invite_code, and member rows.
 * - User accounts are NOT cascaded — members keep their accounts.
 *
 * @param input - `{ organizationId }` to delete.
 * @returns Discriminated result.
 */
export async function deleteTeamAction(input: {
  organizationId: string;
}): Promise<TeamActionResult> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(deleteTeamSchema, input);
  if (!parsed.ok) return parsed;

  if (!(await isOrgOwner(parsed.data.organizationId))) return teamFail("forbidden");

  try {
    await auth.api.deleteOrganization({
      body: { organizationId: parsed.data.organizationId },
      headers: await headers(),
    });
    return { ok: true };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === "unknown") {
      console.error("deleteTeamAction failed", err);
    }
    return teamFail(code);
  }
}

/** Cascade preview shown in the delete-team confirm dialog. */
export type TeamDeletePreview = {
  /** Number of projects that will be removed. */
  projectCount: number;
  /** Number of tasks across those projects. */
  taskCount: number;
};

/**
 * Count the rows that the delete-team cascade will wipe. Surfaces in
 * the confirm dialog so the user understands the blast radius before
 * typing the team name. Owner-only — same gate as `deleteTeamAction`
 * since the count itself can leak organization size.
 *
 * Both counts share a single SQL statement so they read from the same
 * MVCC snapshot (Postgres evaluates subqueries against one statement-
 * level snapshot under default `READ COMMITTED` isolation), preventing
 * a stale projects/tasks mismatch when concurrent writes land between
 * two separate count queries.
 *
 * @param input - `{ organizationId }` to preview.
 * @returns Discriminated result; `data` is `{ projectCount, taskCount }`.
 */
export async function previewTeamDeleteAction(input: {
  organizationId: string;
}): Promise<TeamActionResult<TeamDeletePreview>> {
  try {
    await requireSession();
  } catch {
    return teamFail("unauthorized");
  }
  const parsed = parseOrFail(deleteTeamSchema, input);
  if (!parsed.ok) return parsed;

  if (!(await isOrgOwner(parsed.data.organizationId))) return teamFail("forbidden");

  try {
    const data = await previewTeamDelete(parsed.data.organizationId);
    return { ok: true, data };
  } catch (err) {
    console.error("previewTeamDeleteAction failed", err);
    return teamFail("unknown");
  }
}
