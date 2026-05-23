import { decodeProtectedHeader } from "jose";

/**
 * jose error `code`s that mean the bearer token itself is bad. Anything
 * outside this set is treated as infrastructure failure (JWKS fetch error,
 * shape drift, downstream error) so the caller surfaces a 5xx instead of a
 * 401 — clients must not be told to re-authenticate when the actual problem
 * is the server side.
 *
 * `err.code` is a stable string literal on every jose error class
 * (`node_modules/jose/dist/webapi/util/errors.js`); `err.name` would be the
 * class identifier, which webpack minifies in production and so cannot be
 * matched reliably.
 */
const JWT_ERROR_CODES = new Set([
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
]);

/** Classification of a thrown verify error. */
export type VerifyErrorClass = "token" | "infrastructure";

/**
 * Classify a thrown `verifyJwsAccessToken` error as a token-class failure
 * (caller responds 401) or an infrastructure failure (caller responds 5xx).
 *
 * @param err - Caught error.
 * @returns `"token"` for token-class failures, `"infrastructure"` otherwise.
 */
export function classifyVerifyError(err: unknown): VerifyErrorClass {
  if (!(err instanceof Error)) return "infrastructure";
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === "string" && JWT_ERROR_CODES.has(code)
    ? "token"
    : "infrastructure";
}

/**
 * Pre-flight: does the token have a `kid` in its protected header? Returning
 * false lets the caller short-circuit to 401 without invoking
 * `verifyJwsAccessToken`, whose underlying better-auth helper distinguishes
 * "missing kid" only by string-matching `err.message === "Missing jwt kid"`
 * (`@better-auth/core/src/oauth2/verify.ts:85`) — coupling the route to an
 * unstable error message.
 *
 * Any `decodeProtectedHeader` throw counts as `false`: a token whose
 * protected header cannot be parsed is malformed and equally fails 401.
 *
 * @param token - Raw bearer token.
 * @returns `true` when the header parses and carries a non-empty `kid`.
 */
export function hasKid(token: string): boolean {
  try {
    return Boolean(decodeProtectedHeader(token).kid);
  } catch {
    return false;
  }
}
