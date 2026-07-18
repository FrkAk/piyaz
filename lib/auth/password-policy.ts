/** Minimum password length, enforced by Better Auth (`minPasswordLength`). */
export const PASSWORD_MIN = 8;

/** Maximum password length, enforced by Better Auth (`maxPasswordLength`). */
export const PASSWORD_MAX = 128;

/**
 * User-facing password hint, shown under every field that sets a new
 * password. Length-led on purpose: length is the only rule the server
 * enforces, and NIST 800-63B discourages composition rules because they
 * nudge users toward predictable patterns, so the copy stays away from
 * character-mix advice entirely.
 */
export const PASSWORD_HINT = `Use ${PASSWORD_MIN} or more characters. Longer passphrases are stronger.`;
