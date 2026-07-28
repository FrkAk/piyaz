import { afterEach, expect, test } from "bun:test";
import { auth } from "@/lib/auth";
import {
  setRecipientDomainResolver,
  type DeliverabilityVerdict,
} from "@/lib/auth/recipient-domain";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";

/**
 * Server-side coverage for the sign-up deliverability gate (`lib/auth.ts`
 * `hooks.before` on `/sign-up/email`).
 *
 * A domain that cannot receive mail costs five delivery failures (Cloudflare
 * retries the send) and lands on the account suppression list, which is scored
 * against the hard-bounce rate governing deliverability for every other
 * recipient. The gate rejects those before the account row exists.
 *
 * These pin the gate's wiring, not the DNS probe: they swap the resolver for a
 * fixed verdict. `tests/auth/recipient-domain.test.ts` covers the probe itself
 * against canned DoH answers.
 */

/**
 * Pin the resolver to one verdict for the duration of a test.
 *
 * @param verdict - Verdict every domain resolves to.
 */
function resolveAs(verdict: DeliverabilityVerdict): void {
  setRecipientDomainResolver(async () => verdict);
}

/**
 * Count accounts for an address through the superuser pool, which bypasses
 * RLS so a leaked row is still visible.
 *
 * @param email - Address to look up.
 * @returns Number of matching user rows.
 */
async function userCount(email: string): Promise<number> {
  const sql = superuserPool();
  const rows =
    await sql`SELECT id FROM piyaz_auth."user" WHERE email = ${email}`;
  return rows.length;
}

afterEach(async () => {
  setRecipientDomainResolver(async () => "deliverable");
  await truncateAll();
});

/**
 * Build a sign-up body. Hoisted out of the call site because an inline object
 * literal trips excess-property checking on `termsAccepted`, which is a
 * consent signal the gate reads off the body rather than a Better Auth field.
 *
 * @param email - Address to sign up.
 * @param name - Display name.
 * @returns The sign-up request body.
 */
function signUpBody(email: string, name: string) {
  return {
    email,
    name,
    password: "real-password-12345",
    termsAccepted: true,
  };
}

test("sign-up is rejected for an undeliverable domain, and no user row is written", async () => {
  resolveAs("undeliverable");
  const body = signUpBody("someone@parked.example", "Someone");

  // Message match pins the rejection to the deliverability gate with its
  // address-focused copy, not just any failure on the path.
  await expect(auth.api.signUpEmail({ body })).rejects.toThrow(
    "That email domain cannot receive mail",
  );

  expect(await userCount("someone@parked.example")).toBe(0);
});

test("sign-up succeeds for a deliverable domain", async () => {
  resolveAs("deliverable");
  const body = signUpBody("real@good.test", "Real Person");

  await auth.api.signUpEmail({ body });

  expect(await userCount("real@good.test")).toBe(1);
});

test("an unknown verdict does not block sign-up", async () => {
  // Fail open: a DNS blip must degrade to today's behavior, never to a
  // sign-up outage.
  resolveAs("unknown");
  const body = signUpBody("someone@flaky.test", "Someone");

  await auth.api.signUpEmail({ body });

  expect(await userCount("someone@flaky.test")).toBe(1);
});
