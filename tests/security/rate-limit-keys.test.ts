import { test, expect } from "bun:test";
import type { NextRequest } from "next/server";
import {
  checkAddressCeiling,
  extractKey,
  matchRule,
} from "@/lib/api/rate-limit";

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
  "/api/auth/verify-email",
  "/api/auth/delete-user/callback",
];

/** Token-bearing paths that must not fall through to the catch-all. */
const TOKEN_PATHS = ["/api/auth/reset-password/abc123token"];

test("attack: unauthenticated side-effect endpoints are never keyed on a cookie", () => {
  for (const path of SIDE_EFFECT_PATHS) {
    const rule = matchRule(path);
    expect(rule).not.toBeNull();
    expect(rule!.keyStrategy).toBe("ip");
  }
});

test("credential-guessing endpoints keep the strict brute-force budget", () => {
  const bruteForcePaths = [
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
    "/api/auth/oauth2/register",
    "/api/auth/request-password-reset",
    "/api/auth/send-verification-email",
    "/api/auth/reset-password",
  ];
  for (const path of bruteForcePaths) {
    expect(matchRule(path)?.bindingKey).toBe("auth");
  }
});

test("attack: a token in the path does not fall through to the catch-all", () => {
  // better-auth serves GET /reset-password/:token, which an exact-match rule
  // misses. On the catch-all its key would be a cookie the caller picks.
  for (const path of TOKEN_PATHS) {
    const rule = matchRule(path);
    expect(rule?.keyStrategy).toBe("ip");
    expect(rule?.pattern).not.toBe("/api/*");
  }
});

test("the token endpoint carries a budget a refreshing client fleet can meet", () => {
  const rule = matchRule("/api/auth/oauth2/token");
  expect(rule?.bindingKey).toBe("api");
  expect(rule?.max).toBe(100);
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

test("attack: rotating the MCP bearer token still meets the address ceiling", async () => {
  const rule = matchRule("/api/mcp");
  expect(rule?.addressCeiling).toBe(true);

  const address = "198.51.100.44";
  let blocked = 0;
  for (let i = 0; i < 130; i++) {
    const result = await checkAddressCeiling(
      requestWith({
        authorization: `Bearer rotated-token-${i}`,
        "cf-connecting-ip": address,
        "x-forwarded-for": `${address}, 192.0.2.1`,
      }),
      rule!,
    );
    if (result && !result.allowed) blocked++;
  }

  expect(blocked).toBeGreaterThan(0);
});

test("attack: rotating a forged cookie still meets the catch-all ceiling", async () => {
  const rule = matchRule("/api/task/00000000-0000-4000-8000-000000000000");
  expect(rule?.pattern).toBe("/api/*");
  expect(rule?.addressCeiling).toBe(true);

  const address = "198.51.100.77";
  let blocked = 0;
  for (let i = 0; i < 130; i++) {
    const result = await checkAddressCeiling(
      requestWith({
        cookie: `better-auth.session_token=forged-${i}`,
        "cf-connecting-ip": address,
        "x-forwarded-for": `${address}, 192.0.2.1`,
      }),
      rule!,
    );
    if (result && !result.allowed) blocked++;
  }

  expect(blocked).toBeGreaterThan(0);
});

test("the address ceiling is skipped when no address can be trusted", async () => {
  const rule = matchRule("/api/mcp");
  const result = await checkAddressCeiling(
    requestWith({ authorization: "Bearer some-token" }),
    rule!,
  );

  expect(result).toBeNull();
});
