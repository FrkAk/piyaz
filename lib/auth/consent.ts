import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";
import { consentRequiredResponse } from "@/lib/api/error";
import {
  listOutstandingReconsent,
  type ReconsentDocumentType,
} from "@/lib/data/legal";

/** Route serving the blocking re-acceptance interstitial. */
export const RECONSENT_PATH = "/legal/accept";

/**
 * Personal legal documents the user has not accepted at their current
 * version. Wrapped with React `cache()` so the consent state resolves at
 * most once per request no matter how many gates consult it.
 *
 * @param userId - The authenticated caller's id.
 * @returns Outstanding document types; empty when the user is current.
 */
export const getOutstandingConsent = cache(
  async (userId: string): Promise<ReconsentDocumentType[]> =>
    listOutstandingReconsent(userId),
);

/**
 * Consent gate for authenticated pages: redirect to the re-acceptance
 * interstitial when any personal legal document is outstanding. The
 * interstitial route itself must never call this (redirect loop).
 *
 * @param userId - The authenticated caller's id.
 * @returns Resolves when the user is current on every personal document.
 */
export async function requireLegalConsent(userId: string): Promise<void> {
  const outstanding = await getOutstandingConsent(userId);
  if (outstanding.length > 0) redirect(RECONSENT_PATH);
}

/**
 * Consent gate for API route handlers: a 403 `terms_acceptance_required`
 * response when any personal legal document is outstanding, `null` when the
 * request may proceed. Run after authentication so 401 semantics stay
 * distinct from the consent 403.
 *
 * @param userId - The authenticated caller's id.
 * @returns The blocking 403 response, or `null` to proceed.
 */
export async function consentGateResponse(
  userId: string,
): Promise<Response | null> {
  const outstanding = await getOutstandingConsent(userId);
  if (outstanding.length === 0) return null;
  return consentRequiredResponse(outstanding);
}
