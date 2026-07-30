import { afterEach, expect, test } from "bun:test";
import { auth } from "@/lib/auth";
import { NAME_MAX } from "@/lib/auth/name-policy";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";

/**
 * Server-side coverage for the signup name gate (`lib/auth.ts`
 * `databaseHooks.user.create.before`).
 *
 * Better Auth types the sign-up body's `name` as a bare string, so an empty,
 * whitespace-only, or unbounded value reaches the hook. `updateProfileAction`
 * has always refused all three, which left sign-up as the one path that could
 * land a name the profile form could no longer save.
 *
 * These drive `auth.api.signUpEmail` directly, which runs the same
 * `user.create` hooks as a raw POST to `/api/auth/sign-up/email`, so a caller
 * bypassing the form is held to the same rule.
 */

afterEach(async () => {
  await truncateAll();
});

/**
 * Read a user's stored name by email through the superuser pool.
 *
 * @param email - Account email to look up.
 * @returns The stored name, or undefined when no account exists.
 */
async function findUserName(email: string): Promise<string | undefined> {
  const sql = superuserPool();
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM piyaz_auth."user" WHERE email = ${email}
  `;
  return rows[0]?.name;
}

/**
 * Build a valid sign-up body carrying the given name.
 *
 * @param email - Account email.
 * @param name - Display name under test.
 * @returns The sign-up body, with Terms accepted so only the name gate can fail.
 */
function signUpBody(email: string, name: string) {
  return { email, name, password: "real-password-12345", termsAccepted: true };
}

test("signup with an empty name is rejected and writes no user", async () => {
  const email = "no-name@test.local";

  await expect(
    auth.api.signUpEmail({ body: signUpBody(email, "") }),
  ).rejects.toThrow();

  expect(await findUserName(email)).toBeUndefined();
});

test("signup with a whitespace-only name is rejected", async () => {
  const email = "blank-name@test.local";

  await expect(
    auth.api.signUpEmail({ body: signUpBody(email, "   \t  ") }),
  ).rejects.toThrow();

  expect(await findUserName(email)).toBeUndefined();
});

test("signup with a name past the maximum is rejected", async () => {
  const email = "long-name@test.local";

  await expect(
    auth.api.signUpEmail({ body: signUpBody(email, "a".repeat(NAME_MAX + 1)) }),
  ).rejects.toThrow();

  expect(await findUserName(email)).toBeUndefined();
});

test("signup stores the name trimmed, matching the profile path", async () => {
  const email = "padded-name@test.local";

  await auth.api.signUpEmail({ body: signUpBody(email, "  Ada Lovelace  ") });

  expect(await findUserName(email)).toBe("Ada Lovelace");
});
