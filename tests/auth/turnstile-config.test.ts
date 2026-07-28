import { test, expect, afterAll } from "bun:test";
import { CAPTCHA_PROTECTED_ENDPOINTS, createAuth } from "@/lib/auth";
import { CAPTCHA_RESPONSE_HEADER } from "@/components/auth/turnstile-state";
import { INTERNAL_CLIENT_IP_HEADER } from "@/lib/security/client-ip";
import { setRecipientDomainResolver } from "@/lib/auth/recipient-domain";
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

/**
 * Drive one request through a captcha-armed instance with a stubbed
 * siteverify.
 *
 * `betterFetch` dispatches through the global `fetch`, so replacing it is
 * enough to intercept Cloudflare without `mock.module`, which is
 * process-global and would leak into every later file.
 *
 * Each call carries its own client address: Better Auth's own limiter runs
 * ahead of the captcha plugin and `authRateLimitRules()` caps `/sign-in/email`
 * at five per minute per address, so sharing one address across cases would
 * turn later assertions into silent 429s.
 *
 * @param siteverify - Stubbed siteverify response, or a thrown transport error.
 * @param clientIp - Address stamped for rate-limit isolation.
 * @returns The handler response.
 */
async function requestWithToken(
  siteverify: { body: unknown; status?: number } | "throw",
  clientIp: string,
): Promise<Response> {
  const armed = authWithSecret(TEST_SECRET);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (siteverify === "throw") throw new Error("siteverify unreachable");
    return new Response(JSON.stringify(siteverify.body), {
      status: siteverify.status ?? 200,
    });
  }) as unknown as typeof fetch;
  try {
    return await armed.handler(
      new Request(`${process.env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CAPTCHA_RESPONSE_HEADER]: "a-token",
          [INTERNAL_CLIENT_IP_HEADER]: clientIp,
        },
        body: JSON.stringify({
          email: "captcha-pin@test.local",
          password: "not-the-real-password",
        }),
      }),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("the endpoint list the plugin receives is the one this module declares", () => {
  // Iterating the exported constant rather than a hand-copied literal: a
  // fifth protected endpoint added without a matching test would otherwise
  // leave "every protected endpoint" quietly false.
  const plugins = authWithSecret(TEST_SECRET).options.plugins ?? [];
  const captcha = plugins.find((p) => p.id === "captcha") as
    | { options?: { endpoints?: string[]; allowedHostnames?: string[] } }
    | undefined;
  expect(captcha?.options?.endpoints).toEqual([...CAPTCHA_PROTECTED_ENDPOINTS]);
});

test("tokens are pinned to this deployment's own hostname", () => {
  // Without the pin, a token minted against the dev widget verifies at prod.
  const plugins = authWithSecret(TEST_SECRET).options.plugins ?? [];
  const captcha = plugins.find((p) => p.id === "captcha") as
    | { options?: { allowedHostnames?: string[] } }
    | undefined;
  expect(captcha?.options?.allowedHostnames).toEqual(["example.test"]);
});

test("the header the client sends is the header the plugin reads", async () => {
  // The single point of contact between `turnstile-state.ts` and better-auth.
  // A rename on either side ships a build where every protected submit 400s.
  const response = await requestWithToken(
    { body: { success: true, hostname: "example.test" } },
    "198.18.10.1",
  );
  const body = (await response.json()) as { code?: string };
  expect(body.code).not.toBe("MISSING_RESPONSE");
});

test("a token minted for another hostname is rejected", async () => {
  const response = await requestWithToken(
    { body: { success: true, hostname: "dev.example.invalid" } },
    "198.18.10.2",
  );
  expect(response.status).toBe(403);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe("VERIFICATION_FAILED");
});

test("a failed verification is rejected", async () => {
  const response = await requestWithToken(
    { body: { success: false, "error-codes": ["timeout-or-duplicate"] } },
    "198.18.10.3",
  );
  expect(response.status).toBe(403);
});

test("a siteverify outage fails closed, which is why the secret is the rollback lever", async () => {
  // Documented consequence: an outage takes sign-in down with it, so the
  // rollback is to unset TURNSTILE_SECRET_KEY and redeploy.
  const response = await requestWithToken("throw", "198.18.10.4");
  expect(response.status).toBe(500);
});

test("the deliverability probe is unreachable without a captcha token", async () => {
  // Ordering is structural: the plugin is a router-level `onRequest`, so it
  // runs before the `hooks.before` DNS probe. Without this an attacker could
  // use sign-up as a free DNS oracle.
  let probed = false;
  setRecipientDomainResolver(async () => {
    probed = true;
    return "deliverable";
  });
  try {
    const response = await requestWithoutToken("/sign-up/email");
    expect(response.status).toBe(400);
    expect(probed).toBe(false);
  } finally {
    setRecipientDomainResolver(async () => "deliverable");
  }
});
