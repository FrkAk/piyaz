import "server-only";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  organization,
} from "@/lib/db/auth-schema";

/** Active OAuth session row joined with client and organization metadata. */
export type OAuthSessionRow = {
  id: string;
  clientId: string;
  clientName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  scopes: string[];
  authorizedAt: Date;
  lastActiveAt: Date;
  expiresAt: Date | null;
};

/**
 * List active (non-revoked, non-expired) OAuth refresh tokens for a user
 * with client and org metadata for the settings UI.
 *
 * @param userId - Verified user id.
 * @returns Active session rows ordered by createdAt desc.
 */
export async function listActiveOAuthSessions(
  userId: string,
): Promise<OAuthSessionRow[]> {
  const rows = await db
    .select({
      id: oauthRefreshToken.id,
      clientId: oauthRefreshToken.clientId,
      clientName: oauthClient.name,
      organizationId: oauthRefreshToken.referenceId,
      organizationName: organization.name,
      scopes: oauthRefreshToken.scopes,
      authorizedAt: sql<Date>`coalesce(${oauthRefreshToken.authTime}, ${oauthRefreshToken.createdAt})`,
      lastActiveAt: oauthRefreshToken.createdAt,
      expiresAt: oauthRefreshToken.expiresAt,
    })
    .from(oauthRefreshToken)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthRefreshToken.clientId))
    .leftJoin(
      organization,
      sql`${organization.id}::text = ${oauthRefreshToken.referenceId}`,
    )
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        isNull(oauthRefreshToken.revoked),
        or(
          isNull(oauthRefreshToken.expiresAt),
          gt(oauthRefreshToken.expiresAt, new Date()),
        ),
      ),
    )
    .orderBy(desc(oauthRefreshToken.createdAt));

  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    scopes: row.scopes ?? [],
    authorizedAt: new Date(row.authorizedAt),
    lastActiveAt: new Date(row.lastActiveAt),
    expiresAt: row.expiresAt,
  }));
}

/**
 * Confirm a user owns the named active refresh token (not revoked).
 *
 * @param userId - Verified user id.
 * @param sessionId - UUID of the refresh token.
 * @returns True iff the row exists and belongs to the user.
 */
export async function userOwnsActiveSession(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const owned = await db
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.id, sessionId),
        eq(oauthRefreshToken.userId, userId),
        isNull(oauthRefreshToken.revoked),
      ),
    )
    .limit(1);
  return owned.length > 0;
}

/**
 * Revoke an OAuth refresh token and delete every access token minted from
 * it. Wraps both writes in a transaction.
 *
 * @param userId - Verified user id (re-checked inside the tx).
 * @param sessionId - UUID of the refresh token.
 */
export async function revokeOAuthSession(
  userId: string,
  sessionId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: new Date() })
      .where(
        and(
          eq(oauthRefreshToken.id, sessionId),
          eq(oauthRefreshToken.userId, userId),
          isNull(oauthRefreshToken.revoked),
        ),
      );
    await tx
      .delete(oauthAccessToken)
      .where(eq(oauthAccessToken.refreshId, sessionId));
  });
}

/**
 * Check whether a user has previously approved a specific OAuth client.
 * Drives the consent page's first-time warning. Uses `oauthConsent` rather
 * than `oauthAccessToken` so that token rotation or expiry never re-flags
 * a previously-approved client as first-time.
 *
 * @param userId - Verified user id.
 * @param clientId - OAuth client id to check.
 * @returns True iff at least one `oauthConsent` row exists for the pair.
 */
export async function userHasConsentedTo(
  userId: string,
  clientId: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(
      and(
        eq(oauthConsent.userId, userId),
        eq(oauthConsent.clientId, clientId),
      ),
    )
    .limit(1);
  return existing.length > 0;
}
