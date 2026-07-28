import { test, expect, afterAll } from "bun:test";
import { createAuth } from "@/lib/auth";
import { buildCsp } from "@/lib/security/headers";

/**
 * Config pins for the Turnstile captcha plugin and the CSP it needs.
 *
 * The plugin is boot-gated on `TURNSTILE_SECRET_KEY` so self-host stays
 * bootable without a Cloudflare account, and so unsetting the secret is a
 * working rollback lever when Turnstile itself is unavailable: the plugin
 * fails closed on a siteverify outage, which would otherwise take sign-in
 * down with it. Both directions of that gate are pinned here.
 *
 * `@/lib/auth` is imported statically, BEFORE any env mutation: the module
 * builds the process-wide `auth` singleton at evaluation time, so a dynamic
 * import after setting the secret would arm captcha on the instance every
 * other test file shares.
 */

const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;
const ORIGINAL_URL = process.env.BETTER_AUTH_URL;

/** Cloudflare's published always-passes testing secret. */
const TEST_SECRET = "1x0000000000000000000000000000000AA";

/**
 * Build a fresh Better Auth instance under a given Turnstile secret.
 *
 * `createAuth()` reads env at call time, so each case gets its own instance
 * rather than a mutated singleton.
 *
 * @param secret - Value for `TURNSTILE_SECRET_KEY`, or undefined to unset it.
 * @returns The constructed instance.
 */
function authWithSecret(secret: string | undefined) {
  if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = secret;
  return createAuth();
}

/**
 * Drive one request through a captcha-armed instance's HTTP handler with no
 * `x-captcha-response` header.
 *
 * The plugin rejects the missing header before any siteverify call, so this
 * stays off the network and pins the endpoint wiring itself.
 *
 * @param path - Auth route path under `/api/auth`.
 * @returns The handler response.
 */
async function requestWithoutToken(path: string): Promise<Response> {
  const armed = authWithSecret(TEST_SECRET);
  return armed.handler(
    new Request(`${process.env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "captcha-pin@test.local" }),
    }),
  );
}

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
  if (ORIGINAL_URL === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = ORIGINAL_URL;
});

test("config pin: captcha plugin is registered when a secret is configured", () => {
  const plugins = authWithSecret(TEST_SECRET).options.plugins ?? [];
  expect(plugins.some((p) => p.id === "captcha")).toBe(true);
});

test("config pin: no captcha plugin without a secret, so self-host still boots", () => {
  const plugins = authWithSecret(undefined).options.plugins ?? [];
  expect(plugins.some((p) => p.id === "captcha")).toBe(false);
});

test("config pin: nextCookies stays last even with captcha registered", () => {
  const plugins = authWithSecret(TEST_SECRET).options.plugins ?? [];
  expect(plugins[plugins.length - 1]?.id).toBe("next-cookies");
});

test("every protected endpoint rejects a tokenless request before siteverify", async () => {
  // Pins the explicit endpoint list, most importantly /send-verification-email,
  // which better-auth's default list omits. A regression to the defaults would
  // leave that direct mail trigger captcha-free and every case below green
  // except the third.
  for (const path of [
    "/sign-up/email",
    "/sign-in/email",
    "/send-verification-email",
    "/request-password-reset",
  ]) {
    const response = await requestWithoutToken(path);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("MISSING_RESPONSE");
  }
});

test("unprotected endpoints stay captcha-free", async () => {
  const armed = authWithSecret(TEST_SECRET);
  const response = await armed.handler(
    new Request(`${process.env.BETTER_AUTH_URL}/api/auth/get-session`, {
      method: "GET",
    }),
  );
  expect(response.status).toBe(200);
});

test("production CSP allows the Turnstile iframe origin when configured", () => {
  const csp = buildCsp({ isProd: true, nonce: "abc123", turnstile: true });
  const frameSrc = csp.split("; ").find((d) => d.startsWith("frame-src"))!;
  expect(frameSrc).toBe("frame-src https://challenges.cloudflare.com");
  const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
  expect(scriptSrc).toContain("https://challenges.cloudflare.com");
  expect(scriptSrc).toContain("'strict-dynamic'");
  expect(scriptSrc).toContain("'nonce-abc123'");
});

test("CSP keeps frame-src 'none' when Turnstile is not configured", () => {
  const csp = buildCsp({ isProd: true, nonce: "abc123" });
  expect(csp).toContain("frame-src 'none'");
  expect(csp).not.toContain("challenges.cloudflare.com");
});

test("enabling Turnstile does not widen connect-src", () => {
  // Only pre-clearance needs `connect-src`, and this deployment does not use
  // it. Widening it would let injected script reach a third-party origin.
  const csp = buildCsp({ isProd: true, nonce: "x", turnstile: true });
  const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"))!;
  expect(connectSrc).toBe("connect-src 'self'");
});

test("dev CSP also carries the Turnstile origin when configured", () => {
  const csp = buildCsp({ isProd: false, turnstile: true });
  expect(csp).toContain("frame-src https://challenges.cloudflare.com");
  expect(csp.split("; ").find((d) => d.startsWith("script-src"))!).toContain(
    "https://challenges.cloudflare.com",
  );
});
