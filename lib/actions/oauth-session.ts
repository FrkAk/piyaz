'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod/v4';
import { requireSession } from '@/lib/auth/session';
import { checkActionRateLimit } from '@/lib/actions/rate-limit-action';
import {
  parseOrFail,
  teamFail,
  type TeamActionResult,
} from '@/lib/actions/team-errors';
import type { OAuthSessionView } from '@/lib/actions/oauth-session-types';
import {
  listActiveOAuthSessions,
  revokeOAuthSession,
  userOwnsActiveSession,
} from '@/lib/data/oauth-session';

export type { OAuthSessionView } from '@/lib/actions/oauth-session-types';

/**
 * List all active OAuth refresh tokens (device sessions) the caller owns.
 * Filters out revoked and expired tokens. Joins `oauthClient` for display
 * names and `organization` for org scope.
 *
 * @returns Discriminated result; `data` is the list of active sessions.
 */
export async function listOAuthSessionsAction(): Promise<
  TeamActionResult<OAuthSessionView[]>
> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail('unauthorized');
  }

  try {
    const rows = await listActiveOAuthSessions(userId);
    const data: OAuthSessionView[] = rows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      clientName: row.clientName ?? row.clientId,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      scopes: row.scopes,
      authorizedAt: row.authorizedAt,
      lastActiveAt: row.lastActiveAt,
      expiresAt: row.expiresAt,
    }));
    return { ok: true, data };
  } catch (err) {
    console.error('listOAuthSessionsAction failed', err);
    return teamFail('unknown');
  }
}

const revokeSessionSchema = z.object({
  sessionId: z.uuid('Invalid session id'),
});

/**
 * Revoke a specific OAuth refresh token owned by the caller. Treats foreign
 * or missing tokens as `not_found` (anti-enumeration). Marks the refresh
 * row revoked and deletes any in-flight access tokens minted from it.
 *
 * @param input - `{ sessionId }` (refresh token UUID).
 * @returns Discriminated result.
 */
export async function revokeOAuthSessionAction(input: {
  sessionId: string;
}): Promise<TeamActionResult> {
  let userId: string;
  try {
    const session = await requireSession();
    userId = session.user.id;
  } catch {
    return teamFail('unauthorized');
  }

  const parsed = parseOrFail(revokeSessionSchema, input);
  if (!parsed.ok) return parsed;

  const limit = await checkActionRateLimit(
    { action: 'oauth.revoke', windowSeconds: 60, perUserMax: 20, perIpMax: 60 },
    userId,
  );
  if (!limit.ok) return teamFail('rate_limited');

  try {
    if (!(await userOwnsActiveSession(userId, parsed.data.sessionId))) {
      return teamFail('not_found');
    }
    await revokeOAuthSession(userId, parsed.data.sessionId);

    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    console.error('revokeOAuthSessionAction failed', err);
    return teamFail('unknown');
  }
}
