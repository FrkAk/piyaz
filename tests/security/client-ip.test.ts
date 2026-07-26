import { test, expect, afterEach } from "bun:test";
import {
  clientIpKey,
  isValidIp,
  resolveClientIp,
  trustedProxies,
  trustedProxyHeader,
  UNTRUSTED_IP_KEY,
} from "@/lib/security/client-ip";

/**
 * Attack-path coverage for client address resolution.
 *
 * `resolveClientIp` is the identity behind every pre-auth rate-limit bucket
 * and the `ipAddress` evidence recorded on legal acceptance. A caller that can
 * choose its own value mints a fresh bucket per request and defeats
 * brute-force throttling entirely, so these tests pin that proxy headers are
 * honoured only where something upstream actually sets them.
 *
 * Addresses come from the RFC 5737 documentation ranges.
 */

const CLIENT_IP = "198.51.100.7";
const PROXY_IP = "192.0.2.1";

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

afterEach(() => {
  restoreEnv("DEPLOY_TARGET", originalTarget);
  restoreEnv("TRUSTED_PROXIES", originalProxies);
  restoreEnv("TRUSTED_PROXY_HEADER", originalHeader);
});

test("attack: forwarded headers are ignored when no proxy is declared", () => {
  delete process.env.DEPLOY_TARGET;
  delete process.env.TRUSTED_PROXY_HEADER;

  const headers = new Headers({
    "cf-connecting-ip": CLIENT_IP,
    "x-forwarded-for": CLIENT_IP,
    "x-real-ip": CLIENT_IP,
  });

  expect(resolveClientIp(headers)).toBeNull();
  expect(clientIpKey(headers)).toBe(UNTRUSTED_IP_KEY);
});

test("attack: rotating a forged header cannot mint a fresh bucket", () => {
  delete process.env.DEPLOY_TARGET;
  delete process.env.TRUSTED_PROXY_HEADER;

  const keys = new Set<string>();
  for (let i = 0; i < 50; i++) {
    keys.add(
      clientIpKey(new Headers({ "cf-connecting-ip": `198.51.100.${i}` })),
    );
  }

  expect(keys).toEqual(new Set([UNTRUSTED_IP_KEY]));
});

test("attack: only the named header is read, never a second one", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-real-ip";
  process.env.TRUSTED_PROXIES = PROXY_IP;

  // A proxy that sets only x-real-ip forwards everything else untouched, so
  // both of these are the caller's own bytes.
  const headers = new Headers({
    "cf-connecting-ip": "198.51.100.1",
    "x-forwarded-for": "198.51.100.2",
    "x-real-ip": CLIENT_IP,
  });

  expect(resolveClientIp(headers)).toBe(CLIENT_IP);
});

test("attack: a declared proxy does not re-open cf-connecting-ip on self-host", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  process.env.TRUSTED_PROXIES = PROXY_IP;

  const keys = new Set<string>();
  for (let i = 0; i < 50; i++) {
    keys.add(
      clientIpKey(
        new Headers({
          "cf-connecting-ip": `198.51.100.${i}`,
          "x-forwarded-for": `203.0.113.9, ${CLIENT_IP}`,
        }),
      ),
    );
  }

  expect(keys).toEqual(new Set([CLIENT_IP]));
});

test("a malformed header name trusts nothing", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "not a header";

  expect(trustedProxyHeader()).toBeNull();
  expect(
    resolveClientIp(new Headers({ "x-forwarded-for": CLIENT_IP })),
  ).toBeNull();
});

test("cloudflare target trusts the edge-set header only", () => {
  process.env.DEPLOY_TARGET = "cloudflare";
  // The hosted target reads the edge header regardless of self-host tuning.
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";

  expect(resolveClientIp(new Headers({ "cf-connecting-ip": CLIENT_IP }))).toBe(
    CLIENT_IP,
  );
  expect(
    resolveClientIp(new Headers({ "x-forwarded-for": CLIENT_IP })),
  ).toBeNull();
});

test("named header takes the rightmost hop, not the caller's prefix", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";

  const headers = new Headers({
    "x-forwarded-for": `203.0.113.9, ${CLIENT_IP}`,
  });

  expect(resolveClientIp(headers)).toBe(CLIENT_IP);
});

test("malformed addresses never become a bucket key", () => {
  process.env.DEPLOY_TARGET = "cloudflare";
  delete process.env.TRUSTED_PROXY_HEADER;

  const oversized = "a".repeat(10_000);
  expect(
    resolveClientIp(new Headers({ "cf-connecting-ip": oversized })),
  ).toBeNull();
  expect(
    resolveClientIp(new Headers({ "cf-connecting-ip": "not-an-ip" })),
  ).toBeNull();
  expect(isValidIp("2001:db8::1")).toBe(true);
  expect(isValidIp("999.1.1.1")).toBe(false);
});

test("trusted proxy list parses and ignores blank entries", () => {
  process.env.TRUSTED_PROXIES = ` ${PROXY_IP} , , 10.0.0.1 `;
  expect(trustedProxies()).toEqual([PROXY_IP, "10.0.0.1"]);

  delete process.env.TRUSTED_PROXIES;
  expect(trustedProxies()).toEqual([]);
});
