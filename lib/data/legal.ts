import { withUserContext } from "@/lib/db/rls";
import { legalAcceptances } from "@/lib/db/schema";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import type { LegalDocumentType } from "@/lib/types";

/**
 * Record a user's acceptance of a legal document as compliance evidence.
 *
 * The version is derived from `LEGAL_VERSIONS[documentType]`, not a caller
 * argument, so every row pins the current published version. The insert routes
 * through `withUserContext(userId)` and writes the same `userId` on the row, so
 * the RLS `WITH CHECK (user_id = caller)` is always satisfied.
 *
 * @param userId - Accepting user's id; both the row owner and the RLS scope.
 * @param documentType - Which legal document was accepted.
 * @param context - Request metadata captured as AGB/GDPR evidence.
 * @param context.ipAddress - Client IP, or null when unresolved.
 * @param context.userAgent - Client user agent, or null when unresolved.
 * @returns Resolves once the acceptance row is committed.
 */
export async function recordAcceptance(
  userId: string,
  documentType: LegalDocumentType,
  context: { ipAddress?: string | null; userAgent?: string | null },
): Promise<void> {
  await withUserContext(userId, async (tx) => {
    await tx.insert(legalAcceptances).values({
      userId,
      documentType,
      documentVersion: LEGAL_VERSIONS[documentType],
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });
  });
}
