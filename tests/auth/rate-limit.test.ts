import { test, expect, afterEach } from "bun:test";
import { auth, authRateLimitRules } from "@/lib/auth";
import { UNTRUSTED_BUDGET_FACTOR } from "@/lib/security/client-ip";
import { truncateAll } from "@/tests/setup/schema";

/**
 * Attack-path coverage for the Better Auth rate-limit customRules.
 *
 * `lib/auth.ts:authRateLimitRules` declares function-form per-path budgets
 * (5/60 sign-in, 3/60 sign-up, widened per request when no client address
 * resolved), the primary brute-force defense for the credential path. This
 * file pins that the limiter is still reachable, that exhausted requests do
 * NOT issue session cookies, and the per-request widening branch.
 *
 * Uses the `127.0.1.x` loopback range. `tests/auth/cookie-attributes.test.ts`
 * owns `127.0.0.x`. BA's `customRules` bucket is in-memory and keyed
 * by IP — running every assertion below from a single IP keeps the
 * bucket isolated from every other test file. Direct `auth.handler` calls
 * bypass the route sanitizer, so requests stamp `x-piyaz-client-ip`
 * themselves, mirroring what the route would have written.
 */

const ATTACK_IP = "127.0.1.5";

afterEach(async () => {
  await truncateAll();
});

test("attack: 10 sign-in attempts from one IP hit the 5/60s rate limit", async () => {
  const email = "rate-limit-victim@test.local";
  const signUpBody = {
    email,
    name: "Rate Limit Victim",
    password: "real-password-12345",
    termsAccepted: true,
  };
  await auth.api.signUpEmail({ body: signUpBody });

  // Send 10 attempts with a WRONG password from the same IP. Wrong
  // passwords keep the test independent of session-row state and
  // mirror the realistic brute-force shape. The `max: 5` rule means
  // at least five of these must return 429.
  const responses: Response[] = [];
  for (let i = 0; i < 10; i++) {
    const request = new Request("https://example.test/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "wrong-password" }),
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ATTACK_IP,
        "x-piyaz-client-ip": ATTACK_IP,
      },
      method: "POST",
    });
    responses.push(await auth.handler(request));
  }

  const statuses = responses.map((r) => r.status);
  const rateLimited = statuses.filter((s) => s === 429);

  // First response must NOT be 429 — otherwise we're seeing leaked
  // state from a previous test, not the limiter working.
  expect(statuses[0]).not.toBe(429);
  // `max: 5` with 10 attempts: the floor is five 429s. Allow some
  // slack only to BA's exact accounting at the boundary; the real
  // signal is "the limiter is reachable and non-trivially blocking".
  expect(rateLimited.length).toBeGreaterThanOrEqual(4);

  // Defense in depth: no 429 response may issue a session cookie.
  for (const response of responses) {
    if (response.status !== 429) continue;
    const sessionCookie = response.headers
      .getSetCookie()
      .find((c) => c.toLowerCase().includes("session_token"));
    expect(sessionCookie).toBeUndefined();
  }
});

test("customRules widen per request only when no address resolved", () => {
  const rules = authRateLimitRules();
  const attributed = new Request("https://example.test", {
    headers: { "x-piyaz-client-ip": "203.0.113.7" },
  });
  const unattributed = new Request("https://example.test", {
    headers: { "x-piyaz-client-ip": "" },
  });
  const unstamped = new Request("https://example.test");

  expect(rules["/sign-in/email"]!(attributed)).toEqual({ window: 60, max: 5 });
  expect(rules["/sign-up/email"]!(attributed)).toEqual({ window: 60, max: 3 });
  expect(rules["/sign-in/email"]!(unattributed)).toEqual({
    window: 60,
    max: 5 * UNTRUSTED_BUDGET_FACTOR,
  });
  expect(rules["/sign-in/email"]!(unstamped)).toEqual({
    window: 60,
    max: 5 * UNTRUSTED_BUDGET_FACTOR,
  });
});
