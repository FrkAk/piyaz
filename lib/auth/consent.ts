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
 * version. Wrapped with React `cache()` so stacked gates in one RSC or
 * server-action request (page + action prelude + write authorizer) share
 * a single read; contexts outside a React request scope pay one query per
 * call.
 *
 * @param userId - The authenticated caller's id.
 * @returns Outstanding document types; empty when the user is current.
 */
export const getOutstandingConsent = cache(
  async (userId: string): Promise<ReconsentDocumentType[]> =>
    listOutstandingReconsent(userId),
);

/**
 * Consent gate for authenticated pages and server actions: redirect to the
 * re-acceptance interstitial when any personal legal document is
 * outstanding. In an action, call it outside any try/catch or the thrown
 * redirect is swallowed. The interstitial route and the actions it relies
 * on (accept, export, delete account) must never call this (redirect loop
 * / lockout).
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

/**
 * Thrown by {@link assertLegalConsent} when the caller has outstanding
 * personal documents. Boundaries convert it to their surface's blocking
 * shape: route handlers to the 403 contract via `consentRequiredResponse`,
 * server-action mappers to a redirect to {@link RECONSENT_PATH}.
 */
export class ConsentRequiredError extends Error {
  /** @param outstanding - Document types lacking current-version acceptance. */
  constructor(readonly outstanding: readonly ReconsentDocumentType[]) {
    super("Updated legal documents must be re-accepted.");
    this.name = "ConsentRequiredError";
  }
}

/**
 * Consent gate for shared authorizers that serve both actions and route
 * handlers (e.g. `authorizeWrite`): throws instead of redirecting so each
 * boundary picks its own blocking shape.
 *
 * @param userId - The authenticated caller's id.
 * @returns Resolves when the user is current on every personal document.
 * @throws ConsentRequiredError when any personal document is outstanding.
 */
export async function assertLegalConsent(userId: string): Promise<void> {
  const outstanding = await getOutstandingConsent(userId);
  if (outstanding.length > 0) throw new ConsentRequiredError(outstanding);
}
