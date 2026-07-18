import "server-only";

import { z } from "zod/v4";

/**
 * Closed set of failure codes the team wrappers can return. Mapped from
 * Better Auth's `ORGANIZATION_ERROR_CODES` (57 entries) plus the
 * credential entries of `BASE_ERROR_CODES` (`INVALID_PASSWORD`,
 * `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`,
 * `CREDENTIAL_ACCOUNT_NOT_FOUND`), the freshness entries
 * (`SESSION_EXPIRED`, `SESSION_NOT_FRESH`), and the generic
 * `UNAUTHORIZED` — we never invent a parallel taxonomy.
 */
export type TeamActionFailureCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_input"
  | "not_found"
  | "already_member"
  | "already_invited"
  | "wrong_recipient"
  | "email_verification_required"
  | "membership_limit_reached"
  | "cannot_leave_only_owner"
  | "cannot_delete_sole_owner"
  | "slug_taken"
  | "invalid_password"
  | "session_not_fresh"
  | "email_not_configured"
  | "rate_limited"
  | "dpa_not_accepted"
  | "organization_limit_reached"
  | "unknown";

/** Discriminated result. `T = void` shrinks to `{ ok: true }` (no `data`). */
export type TeamActionResult<T = void> = [T] extends [void]
  ? { ok: true } | TeamActionFailure
  : { ok: true; data: T } | TeamActionFailure;

export type TeamActionFailure = {
  ok: false;
  code: TeamActionFailureCode;
  message: string;
};

/** Human-readable copy keyed by failure code. Single source of truth. */
export const TEAM_ACTION_MESSAGES: Record<TeamActionFailureCode, string> = {
  unauthorized: "You must be signed in to perform this action.",
  forbidden: "You don't have permission to do that.",
  invalid_input: "Invalid input.",
  not_found: "We couldn't find that.",
  already_member: "That user is already a member of this team.",
  already_invited: "That user has already been invited to this team.",
  wrong_recipient: "This invitation belongs to someone else.",
  email_verification_required:
    "Verify your email address before accepting invitations.",
  membership_limit_reached:
    "This team has reached its member limit. Contact the owner.",
  cannot_leave_only_owner:
    "You're the only owner — promote another member first, then leave.",
  cannot_delete_sole_owner:
    "You solely own a team that still has other members. Transfer ownership or delete that team first, then delete your account.",
  slug_taken: "That URL slug is already in use. Try a different one.",
  invalid_password: "Current password is incorrect.",
  session_not_fresh:
    "For security, confirm with your password or sign in again, then retry.",
  email_not_configured:
    "Email is not configured on this deployment, so this action is unavailable.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  dpa_not_accepted:
    "You must accept the data processing agreement to create a team.",
  organization_limit_reached:
    "You've reached the limit of teams you can own. Delete or leave a team before creating another.",
  unknown: "Something went wrong. Please try again.",
};

/**
 * Authorization-rejection codes Better Auth's organization plugin emits.
 * Pinned against `node_modules/better-auth/dist/plugins/organization/error-codes.d.mts`
 * (BA 1.6.x). All collapse to a single `forbidden` failure for the user.
 *
 * If BA adds a new `YOU_ARE_NOT_ALLOWED_TO_*` code, `mapBetterAuthError`
 * logs a warning and falls through to `forbidden` as a safe default —
 * see the heuristic fallback there.
 */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM",
  "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER",
  "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION",
  "YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE",
  "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER",
  "YOU_ARE_NOT_ALLOWED_TO_CREATE_TEAMS_IN_THIS_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_DELETE_TEAMS_IN_THIS_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_TEAM",
  "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_TEAM",
  "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM_MEMBER",
  "YOU_ARE_NOT_ALLOWED_TO_REMOVE_A_TEAM_MEMBER",
  "YOU_ARE_NOT_ALLOWED_TO_ACCESS_THIS_ORGANIZATION",
  "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_ROLE",
  "YOU_ARE_NOT_ALLOWED_TO_UPDATE_A_ROLE",
  "YOU_ARE_NOT_ALLOWED_TO_DELETE_A_ROLE",
  "YOU_ARE_NOT_ALLOWED_TO_READ_A_ROLE",
  "YOU_ARE_NOT_ALLOWED_TO_LIST_A_ROLE",
  "YOU_ARE_NOT_ALLOWED_TO_GET_A_ROLE",
]);

/** Build a failure result with the canonical message for `code`. */
export function teamFail(code: TeamActionFailureCode): TeamActionFailure {
  return { ok: false, code, message: TEAM_ACTION_MESSAGES[code] };
}

/**
 * Translate a Better Auth API error to a `TeamActionFailureCode`. Reads
 * the `body.code` constant key (e.g. `"USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION"`)
 * — never the human message, since that's not a stable identifier.
 *
 * @param err - Caught error from `auth.api.*`.
 * @returns Mapped code; `unknown` for anything we don't explicitly recognize.
 */
export function mapBetterAuthError(err: unknown): TeamActionFailureCode {
  const code = (err as { body?: { code?: string } } | null)?.body?.code;
  if (typeof code !== "string") return "unknown";
  switch (code) {
    case "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION":
      return "already_member";
    case "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION":
      return "already_invited";
    case "INVITATION_NOT_FOUND":
    case "MEMBER_NOT_FOUND":
    case "ORGANIZATION_NOT_FOUND":
    case "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION":
      return "not_found";
    case "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION":
      return "wrong_recipient";
    case "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION":
      return "email_verification_required";
    case "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED":
    case "INVITATION_LIMIT_REACHED":
      return "membership_limit_reached";
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER":
    case "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER":
      return "cannot_leave_only_owner";
    case "CANNOT_DELETE_SOLE_OWNER":
      return "cannot_delete_sole_owner";
    case "ORGANIZATION_ALREADY_EXISTS":
    case "ORGANIZATION_SLUG_ALREADY_TAKEN":
      return "slug_taken";
    case "INVALID_PASSWORD":
      return "invalid_password";
    // deleteUser without a password on a session older than freshAge.
    case "SESSION_EXPIRED":
    case "SESSION_NOT_FRESH":
      return "session_not_fresh";
    case "PASSWORD_TOO_SHORT":
    case "PASSWORD_TOO_LONG":
      return "invalid_input";
    // Session revoked between the action's getSession() and the auth.api
    // call (e.g. a concurrent password change elsewhere revoked it):
    // BA's sensitiveSessionMiddleware throws UNAUTHORIZED.
    case "UNAUTHORIZED":
      return "unauthorized";
    // changePassword on a user without a password-bearing credential row.
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "not_found";
    // organization/create rejected by the DPA consent gate in lib/auth.ts.
    case "DPA_NOT_ACCEPTED":
      return "dpa_not_accepted";
    // organization/create rejected by the owned-org ceiling in lib/auth.ts.
    case "ORGANIZATION_LIMIT_REACHED":
      return "organization_limit_reached";
    default:
      if (FORBIDDEN_CODES.has(code)) return "forbidden";
      if (code.startsWith("YOU_ARE_NOT_ALLOWED_TO_")) {
        console.warn(
          "mapBetterAuthError: unrecognized authz-rejection code — update FORBIDDEN_CODES allowlist",
          { code },
        );
        return "forbidden";
      }
      return "unknown";
  }
}

/**
 * Reject obviously bad input early. Returns the parsed value or a typed
 * `invalid_input` failure carrying the first Zod issue's message.
 */
export function parseOrFail<T>(
  schema: z.ZodType<T>,
  input: unknown,
): { ok: true; data: T } | TeamActionFailure {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    code: "invalid_input",
    message:
      parsed.error.issues[0]?.message ?? TEAM_ACTION_MESSAGES.invalid_input,
  };
}
