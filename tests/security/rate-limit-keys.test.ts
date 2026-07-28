import { test, expect } from "bun:test";
import type { NextRequest } from "next/server";
import {
  ADDRESS_CEILING,
  MCP_HEAVY_LIMIT,
  MCP_STANDARD_LIMIT,
  RATE_LIMIT_RULES,
  checkAddressCeiling,
  extractKey,
  matchRule,
} from "@/lib/api/rate-limit";
import { wranglerRatelimits } from "@/tests/setup/wrangler";

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
  for (let i = 0; i < ADDRESS_CEILING.max + 30; i++) {
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
  for (let i = 0; i < ADDRESS_CEILING.max + 30; i++) {
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

test("the ceiling is skipped when the primary key already is the address", async () => {
  const rule = matchRule("/api/task/00000000-0000-4000-8000-000000000000");
  const address = "198.51.100.99";
  const request = requestWith({ "cf-connecting-ip": address });

  // No cookie, so the session strategy falls back to the address itself; a
  // second counter with the same identity could never reject first.
  const key = await extractKey(request, rule!.keyStrategy);
  expect(key).toBe(address);
  expect(await checkAddressCeiling(request, rule!, key!)).toBeNull();
});

test("one address holds one ceiling budget across rule patterns", async () => {
  const mcpRule = matchRule("/api/mcp");
  const catchAll = matchRule("/api/task/00000000-0000-4000-8000-000000000000");
  const address = "198.51.100.88";

  for (let i = 0; i < ADDRESS_CEILING.max; i++) {
    await checkAddressCeiling(
      requestWith({
        authorization: `Bearer rotated-${i}`,
        "cf-connecting-ip": address,
      }),
      mcpRule!,
    );
  }

  const viaOtherPattern = await checkAddressCeiling(
    requestWith({
      cookie: "better-auth.session_token=forged",
      "cf-connecting-ip": address,
    }),
    catchAll!,
  );
  expect(viaOtherPattern).not.toBeNull();
  expect(viaOtherPattern!.allowed).toBe(false);
});

/**
 * Plain SHA-256 hex digest, the shape `hashKey` must NOT produce for a
 * credential while a secret is configured.
 *
 * @param value - The string to digest.
 * @returns Hex-encoded SHA-256.
 */
async function plainSha256(value: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

test("the cookie key is keyed on the secret, not a bare hash of the credential", async () => {
  const secret = "session-token-value-that-must-not-leak";
  const key = await extractKey(
    requestWith({ cookie: `better-auth.session_token=${secret}` }),
    "session",
  );

  // An unkeyed digest in a persisted log is an offline oracle for the cookie.
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(key).not.toBe(await plainSha256(secret));
});

test("key hashing falls back to plain SHA-256 without a secret", async () => {
  const original = process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_SECRET;
  try {
    const cookie = "cookie-value-without-secret";
    const key = await extractKey(
      requestWith({ cookie: `better-auth.session_token=${cookie}` }),
      "session",
    );
    expect(key).toBe(await plainSha256(cookie));
  } finally {
    if (original === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = original;
  }
});

test("declared budgets equal the Cloudflare binding limits that enforce them", async () => {
  const BINDING_BY_KEY = {
    api: "RATE_LIMIT_API",
    auth: "RATE_LIMIT_AUTH",
    mcp: "RATE_LIMIT_MCP",
    mcpHeavy: "RATE_LIMIT_MCP_HEAVY",
  } as const;

  for (const env of ["production", "dev"] as const) {
    const simpleByName = new Map(
      (await wranglerRatelimits(env)).map((b) => [b.name, b.simple]),
    );
    for (const rule of RATE_LIMIT_RULES) {
      const simple = simpleByName.get(BINDING_BY_KEY[rule.bindingKey ?? "api"]);
      expect({
        env,
        pattern: rule.pattern,
        max: rule.max,
        window: rule.window,
      }).toEqual({
        env,
        pattern: rule.pattern,
        max: simple!.limit,
        window: simple!.period,
      });
    }
    const constantsByBinding: [string, { max: number; window: number }][] = [
      ["RATE_LIMIT_MCP", MCP_STANDARD_LIMIT],
      ["RATE_LIMIT_MCP_HEAVY", MCP_HEAVY_LIMIT],
      ["RATE_LIMIT_ADDRESS", ADDRESS_CEILING],
    ];
    for (const [binding, constant] of constantsByBinding) {
      const simple = simpleByName.get(binding);
      expect(constant.max).toBe(simple!.limit);
      expect(constant.window).toBe(simple!.period);
    }
  }
});
