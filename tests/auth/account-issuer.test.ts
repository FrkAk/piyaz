import { afterEach, expect, test } from "bun:test";
import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";

afterEach(async () => {
  await truncateAll();
});

test("credential signup stores the Better Auth 1.7 account issuer", async () => {
  const email = "account-issuer@test.local";
  const response = await authPost(
    new Request("https://example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "127.0.9.10",
        origin: "https://example.test",
      },
      body: JSON.stringify({
        email,
        name: "Account Issuer",
        password: "account-issuer-password-1",
        termsAccepted: true,
      }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);

  const sql = superuserPool();
  const [row] = await sql<
    Array<{ accountId: string; issuer: string; userId: string }>
  >`
    SELECT
      a."accountId" AS "accountId",
      a."issuer",
      a."userId"::text AS "userId"
    FROM piyaz_auth."account" a
    JOIN piyaz_auth."user" u ON u.id = a."userId"
    WHERE u.email = ${email}
  `;
  expect(row.issuer).toBe("local:credential");
  expect(row.accountId).toBe(row.userId);
});
