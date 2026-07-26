import { test, expect } from "bun:test";
import type { NextRequest } from "next/server";
import { extractKey, matchRule } from "@/lib/api/rate-limit";

/**
 * Attack-path coverage for rate-limit key derivation.
 *
 * A key a caller can choose is a limit a caller can escape. These tests pin
 * that the unauthenticated endpoints with a side effect are keyed on the
 * client address rather than on a session cookie, and that the raw cookie
 * never becomes the key itself, since the key reaches structured logs.
 */

/**
 * Build a request-like object carrying the given headers.
 *
 * @param headers - Header pairs to attach.
 * @returns A value shaped like the `NextRequest` the limiter reads.
 */
function requestWith(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

const SIDE_EFFECT_PATHS = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/oauth2/register",
  "/api/auth/request-password-reset",
  "/api/auth/send-verification-email",
  "/api/auth/reset-password",
  "/api/auth/oauth2/token",
];

test("attack: unauthenticated side-effect endpoints are never keyed on a cookie", () => {
  for (const path of SIDE_EFFECT_PATHS) {
    const rule = matchRule(path);
    expect(rule).not.toBeNull();
    expect(rule!.keyStrategy).toBe("ip");
    expect(rule!.bindingKey).toBe("auth");
  }
});

test("attack: a forged cookie cannot pick the bucket on a side-effect endpoint", async () => {
  const rule = matchRule("/api/auth/request-password-reset");
  const keys = new Set<string>();
  for (let i = 0; i < 25; i++) {
    const key = await extractKey(
      requestWith({ cookie: `better-auth.session_token=forged-${i}` }),
      rule!.keyStrategy,
    );
    keys.add(key ?? "null");
  }

  expect(keys.size).toBe(1);
});

test("the raw session cookie never becomes the rate-limit key", async () => {
  const secret = "session-token-value-that-must-not-leak";
  const key = await extractKey(
    requestWith({ cookie: `better-auth.session_token=${secret}` }),
    "session",
  );

  expect(key).not.toBeNull();
  expect(key).not.toContain(secret);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
});

test("trailing slashes cannot drop a request onto the catch-all", () => {
  for (const path of SIDE_EFFECT_PATHS) {
    expect(matchRule(`${path}/`)?.keyStrategy).toBe("ip");
  }
});
