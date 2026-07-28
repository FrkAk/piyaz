import { test, expect, beforeEach, afterEach } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import {
  ADDRESS_CEILING,
  getBackend,
  matchRule,
  setBackend,
} from "@/lib/api/rate-limit";
import { MemoryRateLimitBackend } from "@/lib/api/rate-limit-memory";
import { INTERNAL_CLIENT_IP_HEADER } from "@/lib/security/client-ip";

/**
 * Attack-path coverage for the real `middleware()` pipeline, which no other
 * file imports: the identity stamp, per-address budget isolation, the
 * address-ceiling 429 body and tighter-headroom advertisement, and
 * RateLimit-header suppression on the shared-cacheable auth documents.
 *
 * The stamp assertion reads the `x-middleware-request-*` encoding
 * `NextResponse.next({ request: { headers } })` emits — the only observable
 * that pins the stamping lines themselves; the middleware rate limiter
 * re-resolves the address from raw headers, so budget separation alone would
 * survive their deletion. Uses the `203.0.113.6x` range; no other test file
 * keys budgets on it.
 */

const CLIENT_A = "203.0.113.61";
const CLIENT_B = "203.0.113.62";
const CLIENT_C = "203.0.113.63";
const CLIENT_D = "203.0.113.64";
const CLIENT_E = "203.0.113.65";

const ORIGINAL_ENV = {
  DEPLOY_TARGET: process.env.DEPLOY_TARGET,
  TRUSTED_PROXY_HEADER: process.env.TRUSTED_PROXY_HEADER,
  TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
};

beforeEach(() => {
  delete process.env.DEPLOY_TARGET;
  delete process.env.TRUSTED_PROXIES;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  setBackend("api", new MemoryRateLimitBackend(60_000));
  setBackend("auth", new MemoryRateLimitBackend(60_000));
  setBackend("mcp", new MemoryRateLimitBackend(60_000));
  setBackend("address", new MemoryRateLimitBackend(60_000));
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The backend slots are process-global; leave later files fresh counters
  // instead of this file's exhausted buckets.
  setBackend("api", new MemoryRateLimitBackend(60_000));
  setBackend("auth", new MemoryRateLimitBackend(60_000));
  setBackend("mcp", new MemoryRateLimitBackend(60_000));
  setBackend("address", new MemoryRateLimitBackend(60_000));
});

test("attack: a forged x-piyaz-client-ip is overwritten with the resolved address", async () => {
  const response = await middleware(
    new NextRequest("https://example.test/sign-in", {
      headers: {
        "x-forwarded-for": CLIENT_A,
        [INTERNAL_CLIENT_IP_HEADER]: "6.6.6.6",
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(
    response.headers.get(`x-middleware-request-${INTERNAL_CLIENT_IP_HEADER}`),
  ).toBe(CLIENT_A);
  expect(response.headers.get("x-middleware-override-headers")).toContain(
    INTERNAL_CLIENT_IP_HEADER,
  );
});

test("attack: exhausting one address's sign-in budget leaves another address untouched", async () => {
  const signIn = (address: string) =>
    middleware(
      new NextRequest("https://example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "x-forwarded-for": address },
      }),
    );
  const budget = matchRule("/api/auth/sign-in/email")!.max;

  for (let i = 0; i < budget; i++) {
    expect((await signIn(CLIENT_A)).status).toBe(200);
  }
  const rejected = await signIn(CLIENT_A);
  expect(rejected.status).toBe(429);
  expect(rejected.headers.get("Retry-After")).not.toBeNull();

  expect((await signIn(CLIENT_B)).status).toBe(200);
});

test("a ceiling rejection names the shared address limit, not the caller's own budget", async () => {
  const ceilingKey = `addr:${CLIENT_C}`;
  for (let i = 0; i < ADDRESS_CEILING.max; i++) {
    await getBackend("address").check(
      ceilingKey,
      ADDRESS_CEILING.max,
      ADDRESS_CEILING.window,
    );
  }

  const response = await middleware(
    new NextRequest("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "x-forwarded-for": CLIENT_C,
        authorization: "Bearer rotating-token",
      },
    }),
  );

  expect(response.status).toBe(429);
  const body = (await response.json()) as { error: string };
  expect(body.error).toContain("Shared address limit");
  expect(body.error).toContain(String(ADDRESS_CEILING.max));
  expect(body.error).not.toContain("piyaz_create");
});

test("an admitted request advertises the ceiling's headroom when it is tighter than the rule's", async () => {
  const rule = matchRule("/api/mcp")!;
  const ceilingKey = `addr:${CLIENT_E}`;
  for (let i = 0; i < ADDRESS_CEILING.max - 5; i++) {
    await getBackend("address").check(
      ceilingKey,
      ADDRESS_CEILING.max,
      ADDRESS_CEILING.window,
    );
  }

  const response = await middleware(
    new NextRequest("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "x-forwarded-for": CLIENT_E,
        authorization: "Bearer fresh-token",
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("RateLimit")).toContain(
    `limit=${rule.max}, remaining=4`,
  );
  expect(response.headers.get("RateLimit-Policy")).toBe(
    `${rule.max};w=${rule.window}`,
  );
  expect(response.headers.get("Retry-After")).toBeNull();
});

test("RateLimit headers are withheld on the shared-cacheable auth documents", async () => {
  const jwks = await middleware(
    new NextRequest("https://example.test/api/auth/jwks", {
      headers: { "x-forwarded-for": CLIENT_D },
    }),
  );
  expect(jwks.status).toBe(200);
  expect(jwks.headers.get("RateLimit")).toBeNull();
  expect(jwks.headers.get("RateLimit-Policy")).toBeNull();

  const other = await middleware(
    new NextRequest("https://example.test/api/auth/get-session", {
      headers: { "x-forwarded-for": CLIENT_D },
    }),
  );
  expect(other.headers.get("RateLimit")).not.toBeNull();
});

test("the CSP admits Turnstile only on the pages that render the widget", async () => {
  // buildCsp is unit-tested with an explicit flag; nothing else pins that
  // middleware actually passes it. Drop the wiring and production ships
  // `frame-src 'none'`, which blocks the widget for every visitor and makes
  // every protected form unsubmittable, with a green suite.
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "0x4AAAAAAA-test";
  try {
    const onAuthPage = await middleware(
      new NextRequest("https://example.test/sign-in"),
    );
    expect(onAuthPage.headers.get("Content-Security-Policy")).toContain(
      "frame-src https://challenges.cloudflare.com",
    );

    // Everywhere else keeps the tighter policy: four pages render a widget,
    // so the whole app does not need the framing allowance.
    const elsewhere = await middleware(
      new NextRequest("https://example.test/api/mcp"),
    );
    expect(elsewhere.headers.get("Content-Security-Policy")).toContain(
      "frame-src 'none'",
    );
  } finally {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  }
});

test("an unconfigured deployment keeps frame-src 'none' on the auth pages too", async () => {
  const response = await middleware(
    new NextRequest("https://example.test/sign-in"),
  );
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  expect(csp).toContain("frame-src 'none'");
  expect(csp).not.toContain("challenges.cloudflare.com");
});
