/** Minimum password length, enforced by Better Auth (`minPasswordLength`). */
export const PASSWORD_MIN = 8;

/** Maximum password length, enforced by Better Auth (`maxPasswordLength`). */
export const PASSWORD_MAX = 128;

/**
 * User-facing password hint, shown under every field that sets a new
 * password. Follows the mainstream sign-up phrasing: advisory ("use"),
 * because length is the only rule the server enforces (NIST 800-63B) and
 * the copy must never demand composition rules that are not checked.
 */
export const PASSWORD_HINT = `Use ${PASSWORD_MIN} or more characters with a mix of letters, numbers & symbols.`;
