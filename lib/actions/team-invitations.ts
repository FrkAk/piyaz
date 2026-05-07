'use server';

import { headers } from 'next/headers';
import { z } from 'zod/v4';
import { auth } from '@/lib/auth';
import { requireSession } from '@/lib/auth/session';
import { isOrgAdmin } from '@/lib/auth/org-permissions';
import {
  mapBetterAuthError,
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from '@/lib/actions/team-errors';
import {
  toInvitationView,
  type BetterAuthInvitationRow,
  type InvitationView,
} from '@/lib/actions/team-invitations-map';
import { findInvitationOrgId } from '@/lib/data/invitation';
import { lookupUserNames } from '@/lib/data/membership';

const cancelSchema = z.object({
  invitationId: z.uuid(),
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
 * returns only `inviterId` on the listInvitations row.
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
  try {
    await requireSession();
  } catch {
    return teamFail('unauthorized');
  }

  const parsed = parseOrFail(listInvitationsSchema, input);
  if (!parsed.ok) return parsed;

  if (!(await isOrgAdmin(parsed.data.organizationId))) return teamFail('forbidden');

  let raw: BetterAuthInvitationRow[];
  try {
    const result = await auth.api.listInvitations({
      query: { organizationId: parsed.data.organizationId },
      headers: await headers(),
    });
    raw = (result ?? []) as BetterAuthInvitationRow[];
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === 'unknown') {
      console.error('listPendingInvitationsAction failed', err);
    }
    return teamFail(code);
  }

  const now = Date.now();
  const pending = raw.filter((row) => {
    if (row.status !== 'pending') return false;
    const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
    return expiresAt.getTime() > now;
  });

  if (pending.length === 0) return { ok: true, data: [] };

  const inviterIds = Array.from(new Set(pending.map((row) => row.inviterId)));
  const nameById = await lookupUserNames(inviterIds);

  const data = pending
    .map((row) =>
      toInvitationView(row, nameById.get(row.inviterId) ?? 'Unknown'),
    )
    .sort((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf());

  return { ok: true, data };
}

/**
 * Cancel a pending invitation. BA enforces `invitation:cancel`
 * (admin+owner) at the endpoint and scopes by the invitation's own
 * organization, so cross-team cancels are rejected.
 *
 * Defense-in-depth: we resolve the invitation's `organizationId` from
 * the DB and run `isOrgAdmin(invitationOrgId)` so the upstream check is
 * scoped to the invitation's own team. A non-existent invitation
 * surfaces a typed `not_found` (preserving the "already cancelled in
 * another tab" UX); BA reveals the same existence signal, so this
 * lookup adds no new info disclosure.
 *
 * @param input - `{ invitationId }` to cancel.
 * @returns Discriminated result.
 */
export async function cancelInvitationAction(input: {
  invitationId: string;
}): Promise<TeamActionResult> {
  try {
    await requireSession();
  } catch {
    return teamFail('unauthorized');
  }

  const parsed = parseOrFail(cancelSchema, input);
  if (!parsed.ok) return parsed;

  const orgId = await findInvitationOrgId(parsed.data.invitationId);
  if (!orgId) return teamFail('not_found');
  if (!(await isOrgAdmin(orgId))) return teamFail('forbidden');

  try {
    await auth.api.cancelInvitation({
      body: { invitationId: parsed.data.invitationId },
      headers: await headers(),
    });
    return { ok: true };
  } catch (err) {
    const code = mapBetterAuthError(err);
    if (code === 'unknown') {
      console.error('cancelInvitationAction failed', err);
    }
    return teamFail(code);
  }
}
