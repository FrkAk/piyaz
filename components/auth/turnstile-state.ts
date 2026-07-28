/**
 * Decision surface for the captcha-protected auth forms.
 *
 * Pure and DOM-free so it can be tested directly, the same split the rest of
 * the client code uses (see `components/workspace/notes/note-meta.ts`). The
 * hook in `TurnstileGate.tsx` holds the React state; the rules about what that
 * state means live here.
 */

/**
 * Request header Better Auth's captcha plugin reads the token from.
 *
 * The single point of contact with the server plugin, which hardcodes this
 * name and offers no body-field or query fallback. Getting it wrong ships a
 * build where every protected submit returns 400 `MISSING_RESPONSE`.
 */
export const CAPTCHA_RESPONSE_HEADER = "x-captcha-response";

/** Why a captcha-protected form is currently refusing to submit. */
export type TurnstileBlockReason = "pending" | "unavailable" | "unsupported";

/**
 * What the form says when a submit is refused.
 *
 * These sit above the submit button and answer one question: why did my click
 * do nothing. They stay terse because the notice below the button carries the
 * explanation and the recovery. Authored here beside that notice copy so the
 * two are written as a pair and cannot drift into saying the same thing twice
 * on one screen.
 */
const BLOCKED_MESSAGES: Readonly<Record<TurnstileBlockReason, string>> = {
  pending: "Complete the verification to continue.",
  unavailable: "Verification has not loaded yet.",
  unsupported: "Verification does not run in this browser.",
};

/**
 * What the notice below the button says: what went wrong, and what to do.
 *
 * `unavailable` names the blocked host, because a visitor running a filter can
 * only act if they know what to allow. `unsupported` is terminal, so it names
 * the one move that works instead of offering a retry that re-runs the same
 * detection and fails identically.
 */
export const TURNSTILE_UNAVAILABLE_NOTICE = {
  before:
    "Verification could not load. A browser extension or network filter may be blocking",
  host: "challenges.cloudflare.com",
  after: ".",
} as const;

/** Terminal notice copy for a browser Turnstile does not support. */
export const TURNSTILE_UNSUPPORTED_NOTICE =
  "Verification does not run in this browser. Open the page in a current Chrome, Firefox, Safari, or Edge to continue.";

/**
 * Whether a submit may proceed.
 *
 * Always true when Turnstile is off, so a deployment without a site key keeps
 * its original behavior. With Turnstile on, a missing token blocks: failing
 * open would let anyone bypass the captcha by blocking the script.
 *
 * @param siteKey - Public site key, or `null` when Turnstile is unconfigured.
 * @param token - Current challenge token, or `null`.
 * @returns `true` when the form may submit.
 */
export function turnstileReady(
  siteKey: string | null,
  token: string | null,
): boolean {
  return siteKey === null || token !== null;
}

/**
 * Header carrier for a Better Auth client call.
 *
 * @param token - Current challenge token, or `null`.
 * @returns `fetchOptions` carrying the token, or `undefined` when there is
 *   none, so nothing empty reaches the wire.
 */
export function turnstileFetchOptions(
  token: string | null,
): { headers: Record<string, string> } | undefined {
  return token === null
    ? undefined
    : { headers: { [CAPTCHA_RESPONSE_HEADER]: token } };
}

/**
 * Message explaining why a submit was refused.
 *
 * @param reason - Current blocked reason.
 * @returns The user-facing message.
 */
export function turnstileBlockedMessage(reason: TurnstileBlockReason): string {
  return BLOCKED_MESSAGES[reason];
}
