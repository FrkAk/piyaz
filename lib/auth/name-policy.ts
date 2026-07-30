/** Maximum display-name length, enforced on every path that sets a name. */
export const NAME_MAX = 80;

/** Rejection message shared by the sign-up gate and the profile action. */
export const NAME_ERROR = `Enter a name of ${NAME_MAX} characters or less`;

/**
 * Normalize a submitted display name to the form that gets stored.
 *
 * The one implementation of the rule, called by the sign-up gate in
 * `lib/auth.ts` and by `updateProfileAction`. Better Auth types the sign-up
 * body's `name` as a bare `z.string()`, which accepts an empty and an
 * unbounded value alike, so the gate cannot lean on the endpoint's own schema.
 *
 * Deliberately dependency-free, like `password-policy.ts`: the sign-up and
 * settings name inputs import {@link NAME_MAX} for their `maxLength`, and a
 * validation library reachable from a client component would land in that
 * page's bundle for the sake of one integer.
 *
 * @param value - Raw name from a request body or form field.
 * @returns The trimmed name, or `null` when it is absent, blank, or over
 *   {@link NAME_MAX}.
 */
export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) return null;
  return trimmed;
}
