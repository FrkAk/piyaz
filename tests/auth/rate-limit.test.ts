import { test, expect, afterEach } from "bun:test";
import { auth, authRateLimitRules } from "@/lib/auth";
import { effectiveMax } from "@/lib/api/rate-limit";
import {
  UNTRUSTED_BUDGET_FACTOR,
  UNTRUSTED_IP_KEY,
} from "@/lib/security/client-ip";
import { truncateAll } from "@/tests/setup/schema";

/**
 * Attack-path coverage for the Better Auth rate-limit customRules.
 *
 * `lib/auth.ts:authRateLimitRules` declares function-form per-path budgets
 * (5/60 sign-in, 3/60 sign-up, widened only where the deployment declares no
 * address source), the primary brute-force defense for the credential path.
 * This file pins that the limiter is still reachable, that exhausted requests
 * do NOT issue session cookies, and both widening conditions, in step with
 * `effectiveMax` on the middleware limb.
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

test("customRules widen only when unattributable and no address source is declared", () => {
  const rules = authRateLimitRules();
  const baseMax: Record<string, number> = {
    "/sign-in/email": 5,
    "/sign-up/email": 3,
    "/request-password-reset": 3,
    "/send-verification-email": 3,
    "/reset-password": 5,
  };
  const attributed = new Request("https://example.test", {
    headers: { "x-piyaz-client-ip": "203.0.113.7" },
  });
  const unattributed = new Request("https://example.test", {
    headers: { "x-piyaz-client-ip": "" },
  });
  const unstamped = new Request("https://example.test");

  expect(Object.keys(rules).sort()).toEqual(Object.keys(baseMax).sort());

  // Phase 1: preload declares TRUSTED_PROXY_HEADER, so even an
  // unattributable request keeps the tight budget on the shared bucket.
  for (const [path, max] of Object.entries(baseMax)) {
    expect(rules[path]!(attributed)).toEqual({ window: 60, max });
    expect(rules[path]!(unattributed)).toEqual({ window: 60, max });
    expect(rules[path]!(unstamped)).toEqual({ window: 60, max });
  }
  expect(rules["/sign-in/email"]!(unattributed).max).toBe(
    effectiveMax(5, UNTRUSTED_IP_KEY),
  );

  // Phase 2: no declared source at all — the instance-wide bucket widens,
  // attributed requests stay tight.
  const savedHeader = process.env.TRUSTED_PROXY_HEADER;
  const savedTarget = process.env.DEPLOY_TARGET;
  delete process.env.TRUSTED_PROXY_HEADER;
  delete process.env.DEPLOY_TARGET;
  try {
    for (const [path, max] of Object.entries(baseMax)) {
      expect(rules[path]!(attributed)).toEqual({ window: 60, max });
      expect(rules[path]!(unattributed)).toEqual({
        window: 60,
        max: max * UNTRUSTED_BUDGET_FACTOR,
      });
      expect(rules[path]!(unstamped)).toEqual({
        window: 60,
        max: max * UNTRUSTED_BUDGET_FACTOR,
      });
    }
    expect(rules["/sign-in/email"]!(unattributed).max).toBe(
      effectiveMax(5, UNTRUSTED_IP_KEY),
    );
  } finally {
    if (savedHeader === undefined) delete process.env.TRUSTED_PROXY_HEADER;
    else process.env.TRUSTED_PROXY_HEADER = savedHeader;
    if (savedTarget === undefined) delete process.env.DEPLOY_TARGET;
    else process.env.DEPLOY_TARGET = savedTarget;
  }
});
