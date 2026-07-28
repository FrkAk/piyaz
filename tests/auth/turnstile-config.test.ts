import { test, expect, afterAll } from "bun:test";
import { buildCsp } from "@/lib/security/headers";

/**
 * Config pins for the Turnstile captcha plugin and the CSP it needs.
 *
 * The plugin is boot-gated on `TURNSTILE_SECRET_KEY` so self-host stays
 * bootable without a Cloudflare account, and so unsetting the secret is a
 * working rollback lever when Turnstile itself is unavailable: the plugin
 * fails closed on a siteverify outage, which would otherwise take sign-in
 * down with it. Both directions of that gate are pinned here.
 */

const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;
const ORIGINAL_URL = process.env.BETTER_AUTH_URL;

/**
 * Build a fresh Better Auth instance under a given Turnstile secret.
 *
 * `createAuth()` reads boot-time env once at construction, so each case needs
 * its own instance rather than a mutated singleton.
 *
 * @param secret - Value for `TURNSTILE_SECRET_KEY`, or undefined to unset it.
 * @returns The constructed instance's plugin list.
 */
async function pluginsWithSecret(secret: string | undefined) {
  if (secret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = secret;
  const { createAuth } = await import("@/lib/auth");
  return createAuth().options.plugins ?? [];
}

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
  if (ORIGINAL_URL === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = ORIGINAL_URL;
});

test("config pin: captcha plugin is registered when a secret is configured", async () => {
  const plugins = await pluginsWithSecret(
    "1x0000000000000000000000000000000AA",
  );
  expect(plugins.some((p) => p.id === "captcha")).toBe(true);
});

test("config pin: no captcha plugin without a secret, so self-host still boots", async () => {
  const plugins = await pluginsWithSecret(undefined);
  expect(plugins.some((p) => p.id === "captcha")).toBe(false);
});

test("config pin: nextCookies stays last even with captcha registered", async () => {
  const plugins = await pluginsWithSecret(
    "1x0000000000000000000000000000000AA",
  );
  expect(plugins[plugins.length - 1]?.id).toBe("next-cookies");
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
