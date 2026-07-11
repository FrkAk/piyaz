import { afterEach, describe, expect, test } from "bun:test";
import { auth } from "@/lib/auth";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";

/**
 * End-to-end account deletion through `auth.api.deleteUser` with headers
 * only, exactly as `deleteAccountAction` dispatches it (no `request`
 * object). Pins the memberless-owned-team cascade: the `beforeDelete`
 * hook must not depend on `ctx.request`, which server-action dispatch
 * never carries.
 *
 * Uses the `127.0.3.x` loopback range via `cf-connecting-ip` (see the
 * range registry note in tests/auth/change-password.test.ts).
 */

afterEach(async () => {
  await truncateAll();
});

/**
 * Sign up a fresh user and sign in through the real handler.
 *
 * @param email - Account email.
 * @param ip - Loopback IP for the sign-in rate bucket.
 * @returns The user id and a session cookie pair.
 */
async function signUpAndSignIn(
  email: string,
  ip: string,
): Promise<{ userId: string; cookie: string }> {
  const password = "longpassword123";
  const body = { name: "Cascade Test", email, password, termsAccepted: true };
  const signedUp = await auth.api.signUpEmail({ body });
  const response = await auth.handler(
    new Request("https://example.test/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password }),
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: "https://example.test",
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const raw = response.headers
    .getSetCookie()
    .find((c) => c.toLowerCase().includes("session_token"));
  expect(raw).toBeDefined();
  return { userId: signedUp.user.id, cookie: raw!.split(";")[0] };
}

describe("account deletion cascade via auth.api.deleteUser", () => {
  test("deletes a solely owned memberless team and the user without a request context", async () => {
    const su = superuserPool();
    const { userId, cookie } = await signUpAndSignIn(
      "cascade-owner@test.local",
      "127.0.3.1",
    );
    const [org] = await su<{ id: string }[]>`
      INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
      VALUES ('Cascade Solo Team', 'cascade-solo-team', now())
      RETURNING id
    `;
    await su`
      INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${org.id}, ${userId}, 'owner', now())
    `;

    await auth.api.deleteUser({
      body: {},
      headers: new Headers({ cookie }),
    });

    const [{ users }] = await su<{ users: string }[]>`
      SELECT count(*)::text AS users FROM piyaz_auth."user" WHERE id = ${userId}
    `;
    const [{ orgs }] = await su<{ orgs: string }[]>`
      SELECT count(*)::text AS orgs FROM piyaz_auth."organization" WHERE id = ${org.id}
    `;
    expect(users).toBe("0");
    expect(orgs).toBe("0");

    const acceptances = await su<
      { user_id: string | null; ip_address: string | null }[]
    >`
      SELECT user_id, ip_address FROM legal_acceptances
    `;
    expect(acceptances.length).toBe(2);
    for (const row of acceptances) {
      expect(row.user_id).toBeNull();
      expect(row.ip_address).toBeNull();
    }
  });

  test("blocks deletion while a solely owned team still has other members", async () => {
    const su = superuserPool();
    const { userId, cookie } = await signUpAndSignIn(
      "cascade-blocked@test.local",
      "127.0.3.2",
    );
    const [org] = await su<{ id: string }[]>`
      INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
      VALUES ('Cascade Blocked Team', 'cascade-blocked-team', now())
      RETURNING id
    `;
    const [other] = await su<{ id: string }[]>`
      INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES ('Other Member', 'cascade-other@test.local', true, now())
      RETURNING id
    `;
    await su`
      INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${org.id}, ${userId}, 'owner', now()), (${org.id}, ${other.id}, 'member', now())
    `;

    await expect(
      auth.api.deleteUser({ body: {}, headers: new Headers({ cookie }) }),
    ).rejects.toThrow();

    const [{ users }] = await su<{ users: string }[]>`
      SELECT count(*)::text AS users FROM piyaz_auth."user" WHERE id = ${userId}
    `;
    expect(users).toBe("1");
  });
});
