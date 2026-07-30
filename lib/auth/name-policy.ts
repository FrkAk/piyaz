import { z } from "zod/v4";

/** Maximum display-name length, enforced on every path that sets a name. */
export const NAME_MAX = 80;

/**
 * Display-name rule shared by sign-up and profile update.
 *
 * Trims before validating, so padding neither passes as a name nor reaches the
 * database. Better Auth types the sign-up body's `name` as a bare `z.string()`,
 * which accepts an empty and an unbounded value alike, so the sign-up hook in
 * `lib/auth.ts` applies this schema to keep both write paths on one rule.
 */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(NAME_MAX, `Name must be ${NAME_MAX} characters or less`);
