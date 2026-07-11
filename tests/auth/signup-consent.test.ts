import { afterEach, expect, test } from "bun:test";
import { auth } from "@/lib/auth";
import { legalAcceptances } from "@/lib/db/schema";
import { withUserContext } from "@/lib/db/rls";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";

/**
 * Server-side coverage for the signup consent gate (`lib/auth.ts`
 * `databaseHooks.user.create`): the `before` hook rejects account
 * creation unless Terms are accepted, and the `after` hook persists one
 * `terms` and one `privacy` acceptance row per account with the pinned
 * LEGAL_VERSIONS version, timestamp, resolved client IP, and user-agent.
 *
 * These drive `auth.api.signUpEmail` directly, which runs the same
 * `user.create` hooks as a raw POST to `/api/auth/sign-up/email`, so a
 * caller that skips the client checkbox is rejected by construction.
 */

afterEach(async () => {
  await truncateAll();
});

/**
 * Resolve a user's id by email through the superuser pool.
 *
 * @param email - Account email to look up.
 * @returns The user id, or undefined when no account exists.
 */
async function findUserId(email: string): Promise<string | undefined> {
  const sql = superuserPool();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM piyaz_auth."user" WHERE email = ${email}
  `;
  return rows[0]?.id;
}

/**
 * Count every acceptance row in the table via the superuser pool, which
 * bypasses RLS so a leaked or misattributed row is still visible.
 *
 * @returns Total `legal_acceptances` row count.
 */
async function totalAcceptanceRows(): Promise<number> {
  const sql = superuserPool();
  const rows = await sql`SELECT id FROM legal_acceptances`;
  return rows.length;
}

test("signup without Terms acceptance is rejected and writes no user or rows", async () => {
  const email = "no-consent@test.local";
  const body = {
    email,
    name: "No Consent",
    password: "real-password-12345",
  };

  await expect(auth.api.signUpEmail({ body })).rejects.toThrow();

  expect(await findUserId(email)).toBeUndefined();
  expect(await totalAcceptanceRows()).toBe(0);
});

test("signup with Terms acceptance creates the user and two acceptance rows", async () => {
  const email = "consenting@test.local";
  const ip = "203.0.113.42";
  const userAgent = "PiyazConsentTest/1.0";
  const body = {
    email,
    name: "Consenting User",
    password: "real-password-12345",
    termsAccepted: true,
  };

  await auth.api.signUpEmail({
    body,
    headers: new Headers({
      "cf-connecting-ip": ip,
      "user-agent": userAgent,
    }),
  });

  const userId = await findUserId(email);
  if (!userId) throw new Error(`expected an account for ${email}`);

  const rows = await withUserContext(userId, async (tx) =>
    tx.select().from(legalAcceptances),
  );
  expect(rows.length).toBe(2);

  const byType = new Map(rows.map((row) => [row.documentType, row]));
  const terms = byType.get("terms");
  const privacy = byType.get("privacy");
  expect(terms).toBeDefined();
  expect(privacy).toBeDefined();

  for (const row of rows) {
    expect(row.userId).toBe(userId);
    expect(row.ipAddress).toBe(ip);
    expect(row.userAgent).toBe(userAgent);
    expect(row.acceptedAt).toBeInstanceOf(Date);
  }
  expect(terms!.documentVersion).toBe(LEGAL_VERSIONS.terms);
  expect(privacy!.documentVersion).toBe(LEGAL_VERSIONS.privacy);
});

test("client IP resolves from the first x-forwarded-for entry", async () => {
  const email = "forwarded-consent@test.local";
  const userAgent = "PiyazConsentTest/1.0";
  const body = {
    email,
    name: "Forwarded Consent",
    password: "real-password-12345",
    termsAccepted: true,
  };

  await auth.api.signUpEmail({
    body,
    headers: new Headers({
      "x-forwarded-for": "198.51.100.9, 10.0.0.1",
      "user-agent": userAgent,
    }),
  });

  const userId = await findUserId(email);
  if (!userId) throw new Error(`expected an account for ${email}`);

  const rows = await withUserContext(userId, async (tx) =>
    tx.select().from(legalAcceptances),
  );
  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(row.ipAddress).toBe("198.51.100.9");
  }
});
