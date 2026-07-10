import { and, desc, eq } from "drizzle-orm";
import { withUserContext, withUserContextRead } from "@/lib/db/rls";
import {
  LEGAL_IP_MAX_CHARS,
  LEGAL_USER_AGENT_MAX_CHARS,
  legalAcceptances,
} from "@/lib/db/schema";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import type { LegalDocumentType } from "@/lib/types";

/**
 * Truncate client-supplied request metadata to its storage cap.
 *
 * @param value - Raw header-derived value, or null when unresolved.
 * @param maxChars - Storage cap matching the table's check constraint.
 * @returns The capped value, or null when absent.
 */
function capMetadata(
  value: string | null | undefined,
  maxChars: number,
): string | null {
  if (!value) return null;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/**
 * Record a user's acceptance of a legal document as compliance evidence.
 *
 * The version is derived from `LEGAL_VERSIONS[documentType]`, not a caller
 * argument, so every row pins the current published version. The insert routes
 * through `withUserContext(userId)` and writes the same `userId` on the row, so
 * the RLS `WITH CHECK (user_id = caller)` is always satisfied. IP and
 * user-agent are truncated to their storage caps so oversized headers cannot
 * fail the insert.
 *
 * @param userId - Accepting user's id; both the row owner and the RLS scope.
 * @param documentType - Which legal document was accepted.
 * @param context - Request metadata captured as AGB/GDPR evidence.
 * @param context.ipAddress - Client IP, or null when unresolved.
 * @param context.userAgent - Client user agent, or null when unresolved.
 * @param context.organizationId - Accepting organization for org-scoped
 * documents (dpa); omit for personal documents.
 * @returns Resolves once the acceptance row is committed.
 */
export async function recordAcceptance(
  userId: string,
  documentType: LegalDocumentType,
  context: {
    ipAddress?: string | null;
    userAgent?: string | null;
    organizationId?: string | null;
  },
): Promise<void> {
  await withUserContext(userId, async (tx) => {
    await tx.insert(legalAcceptances).values({
      userId,
      documentType,
      documentVersion: LEGAL_VERSIONS[documentType],
      organizationId: context.organizationId ?? null,
      ipAddress: capMetadata(context.ipAddress, LEGAL_IP_MAX_CHARS),
      userAgent: capMetadata(context.userAgent, LEGAL_USER_AGENT_MAX_CHARS),
    });
  });
}

/**
 * Delete every acceptance row belonging to the user, under the user's own
 * RLS scope.
 *
 * Compensating cleanup for the signup consent hook: when the second
 * acceptance insert fails after the first committed, the hook deletes the
 * just-created user, whose FK would otherwise null `user_id` on the
 * surviving row and strand unattributable evidence. Runs before the user
 * delete so no orphan row outlives its account.
 *
 * @param userId - The user whose acceptance rows are removed.
 * @returns Resolves once the rows are deleted.
 */
export async function removeAcceptances(userId: string): Promise<void> {
  await withUserContext(userId, async (tx) => {
    await tx
      .delete(legalAcceptances)
      .where(eq(legalAcceptances.userId, userId));
  });
}

/**
 * Read the caller's latest `dpa` acceptance for one organization, pinned to
 * the current `LEGAL_VERSIONS.dpa`. Returns `null` when the caller has never
 * accepted the current version for that organization, so a version bump
 * re-offers the DPA and each team carries its own acceptance evidence. Routes
 * through `withUserContextRead(userId)`, so RLS scopes the read to the
 * caller's own rows.
 *
 * @param userId - The caller's id; the RLS scope for the read.
 * @param organizationId - The team whose DPA acceptance is read.
 * @returns The pinned-version acceptance (`version` + `acceptedAt`), or `null`.
 */
export async function getDpaAcceptance(
  userId: string,
  organizationId: string,
): Promise<{ version: string; acceptedAt: Date } | null> {
  const version = LEGAL_VERSIONS.dpa;
  const [rows] = await withUserContextRead(userId, (read) => [
    read
      .select({
        documentVersion: legalAcceptances.documentVersion,
        acceptedAt: legalAcceptances.acceptedAt,
      })
      .from(legalAcceptances)
      .where(
        and(
          eq(legalAcceptances.documentType, "dpa"),
          eq(legalAcceptances.documentVersion, version),
          eq(legalAcceptances.organizationId, organizationId),
        ),
      )
      .orderBy(desc(legalAcceptances.acceptedAt))
      .limit(1),
  ]);
  const row = rows[0];
  return row
    ? { version: row.documentVersion, acceptedAt: row.acceptedAt }
    : null;
}
