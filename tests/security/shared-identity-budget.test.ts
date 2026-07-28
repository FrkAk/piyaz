import { test, expect, afterEach } from "bun:test";
import { getIPFromHeader } from "@better-auth/core/utils/ip";
import { effectiveMax, extractKey, matchRule } from "@/lib/api/rate-limit";
import type { NextRequest } from "next/server";
import {
  addressPolicyError,
  hasTrustedAddressSource,
  resolveClientIp,
  UNTRUSTED_BUDGET_FACTOR,
  UNTRUSTED_IP_KEY,
} from "@/lib/security/client-ip";

/**
 * Coverage for what a budget means once caller identity collapses, and for the
 * chain walk agreeing with the resolver Better Auth runs on the same request.
 *
 * A per-address budget silently becomes an instance-wide ceiling when no
 * address resolves, which denies service instead of throttling abuse: sign-in
 * at 5/60 for a whole deployment locks out ordinary traffic and hands any
 * caller a trivial way to hold every login closed. These pin that the shared
 * bucket is widened, that it is widened only where no address source is
 * declared, and that a declared proxy list attributes past the proxy rather
 * than pooling every caller behind it.
 *
 * Addresses come from the RFC 5737 documentation ranges.
 */

const CLIENT_IP = "198.51.100.7";
const PROXY_IP = "192.0.2.1";
const CDN_IP = "192.0.2.9";

const originalTarget = process.env.DEPLOY_TARGET;
const originalProxies = process.env.TRUSTED_PROXIES;
const originalHeader = process.env.TRUSTED_PROXY_HEADER;

/**
 * Restore a process env key, deleting it when it was previously unset.
 *
 * @param key - Environment variable name.
 * @param value - Value captured before the test mutated it.
 */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Build a request-like object carrying the given headers.
 *
 * @param headers - Header pairs to attach.
 * @returns A value shaped like the `NextRequest` the limiter reads.
 */
function requestWith(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

afterEach(() => {
  restoreEnv("DEPLOY_TARGET", originalTarget);
  restoreEnv("TRUSTED_PROXIES", originalProxies);
  restoreEnv("TRUSTED_PROXY_HEADER", originalHeader);
});

test("distinct callers are not locked out of sign-in by a shared bucket", async () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "none";

  const rule = matchRule("/api/auth/sign-in/email");
  expect(rule).not.toBeNull();

  // Every caller collapses onto one key here, so the rule's per-caller budget
  // would otherwise cap the whole instance at `rule.max` sign-ins per window.
  const key = await extractKey(
    requestWith({ "x-forwarded-for": CLIENT_IP }),
    rule!.keyStrategy,
  );
  expect(key).toBe(UNTRUSTED_IP_KEY);
  expect(effectiveMax(rule!.max, key!)).toBe(
    rule!.max * UNTRUSTED_BUDGET_FACTOR,
  );
});

test("a declared address source keeps the per-caller budget exact", async () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";

  const rule = matchRule("/api/auth/sign-in/email");
  const key = await extractKey(
    requestWith({ "x-forwarded-for": CLIENT_IP }),
    rule!.keyStrategy,
  );

  expect(key).toBe(CLIENT_IP);
  expect(effectiveMax(rule!.max, key!)).toBe(rule!.max);
});

test("the hosted target never widens a budget its binding will not honor", () => {
  process.env.DEPLOY_TARGET = "cloudflare";

  // A stripped edge header resolves no address, but the Cloudflare binding
  // enforces its own configured limit, so advertising a widened one would
  // promise headroom that does not exist.
  expect(hasTrustedAddressSource()).toBe(true);
  expect(effectiveMax(5, UNTRUSTED_IP_KEY)).toBe(5);
});

test("a declared proxy attributes past it instead of pooling callers behind it", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  process.env.TRUSTED_PROXIES = PROXY_IP;

  const chain = `${CLIENT_IP}, ${PROXY_IP}`;
  const headers = new Headers({ "x-forwarded-for": chain });

  expect(resolveClientIp(headers)).toBe(CLIENT_IP);
  // The identity Better Auth records for the same request has to match, or the
  // rate-limit key and the acceptance evidence name different callers.
  expect(resolveClientIp(headers)).toBe(
    getIPFromHeader(chain, { ipv6Subnet: 64, trustedProxies: [PROXY_IP] }),
  );
});

test("callers behind one declared proxy keep distinct buckets", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  process.env.TRUSTED_PROXIES = `${PROXY_IP},${CDN_IP}`;

  const keys = new Set<string | null>();
  for (let i = 0; i < 10; i++) {
    keys.add(
      resolveClientIp(
        new Headers({
          "x-forwarded-for": `198.51.100.${i}, ${CDN_IP}, ${PROXY_IP}`,
        }),
      ),
    );
  }

  expect(keys.size).toBe(10);
});

test("attack: a caller-prepended entry is still never selected", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  process.env.TRUSTED_PROXIES = PROXY_IP;

  // Only the rightmost hop was observed by the proxy; everything left of it is
  // the caller's own bytes, including an entry impersonating another client.
  expect(
    resolveClientIp(
      new Headers({
        "x-forwarded-for": `203.0.113.9, ${CLIENT_IP}, ${PROXY_IP}`,
      }),
    ),
  ).toBe(CLIENT_IP);
});

test("an undeclared address policy is rejected, an explicit one accepted", () => {
  delete process.env.TRUSTED_PROXY_HEADER;
  expect(addressPolicyError()).toContain("TRUSTED_PROXY_HEADER is required");

  process.env.TRUSTED_PROXY_HEADER = "not a header";
  expect(addressPolicyError()).toContain("not a valid header name");

  process.env.TRUSTED_PROXY_HEADER = "none";
  expect(addressPolicyError()).toBeNull();
  expect(hasTrustedAddressSource()).toBe(false);

  process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
  expect(addressPolicyError()).toBeNull();
  expect(hasTrustedAddressSource()).toBe(true);
});
