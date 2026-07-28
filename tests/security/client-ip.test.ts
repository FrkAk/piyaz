import { test, expect, afterEach } from "bun:test";
import { normalizeIP } from "@better-auth/core/utils/ip";
import {
  clientIpKey,
  INTERNAL_CLIENT_IP_HEADER,
  IPV6_SUBNET_BITS,
  isValidIp,
  resolveClientIp,
  stampClientIpHeader,
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

test("attack: rotating within one IPv6 allocation cannot mint fresh buckets", () => {
  process.env.DEPLOY_TARGET = "cloudflare";

  // A single client is routinely handed a whole /64, so every address below
  // belongs to one caller. Unmasked, each is its own bucket and every
  // per-address budget stops bounding anything.
  const keys = new Set<string>();
  for (let i = 0; i < 50; i++) {
    keys.add(
      clientIpKey(new Headers({ "cf-connecting-ip": `2001:db8::${i}:1` })),
    );
  }

  expect(keys.size).toBe(1);
});

test("distinct IPv6 allocations keep distinct buckets", () => {
  process.env.DEPLOY_TARGET = "cloudflare";

  const first = clientIpKey(new Headers({ "cf-connecting-ip": "2001:db8::1" }));
  const second = clientIpKey(
    new Headers({ "cf-connecting-ip": "2001:db8:0:1::1" }),
  );

  expect(first).not.toBe(second);
});

test("IPv4 is unmasked and an IPv4-mapped address shares its bucket", () => {
  process.env.DEPLOY_TARGET = "cloudflare";

  expect(resolveClientIp(new Headers({ "cf-connecting-ip": CLIENT_IP }))).toBe(
    CLIENT_IP,
  );
  // A dual-stack client reaching the same address two ways gets one bucket.
  expect(
    resolveClientIp(new Headers({ "cf-connecting-ip": `::ffff:${CLIENT_IP}` })),
  ).toBe(CLIENT_IP);
});

test("trusted proxy list parses and ignores blank entries", () => {
  process.env.TRUSTED_PROXIES = ` ${PROXY_IP} , , 10.0.0.1 `;
  expect(trustedProxies()).toEqual([PROXY_IP, "10.0.0.1"]);

  delete process.env.TRUSTED_PROXIES;
  expect(trustedProxies()).toEqual([]);
});

test("attack: an appended ip:port hop cannot hand the key to the caller's prefix", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  delete process.env.TRUSTED_PROXIES;

  // Azure App Gateway / App Service and IIS ARR append `ip:port`. The caller
  // controls every hop left of the rightmost; only the rightmost may win.
  expect(
    resolveClientIp(
      new Headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.5:41234" }),
    ),
  ).toBe("203.0.113.5");
  expect(
    resolveClientIp(
      new Headers({ "x-forwarded-for": "9.9.9.9, [2001:db8::5]:443" }),
    ),
  ).toBe(normalizeIP("2001:db8::5", { ipv6Subnet: IPV6_SUBNET_BITS }));
});

test("attack: an invalid rightmost hop resolves nothing, never a left hop", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  delete process.env.TRUSTED_PROXIES;

  expect(
    resolveClientIp(new Headers({ "x-forwarded-for": "9.9.9.9, unknown" })),
  ).toBeNull();
  expect(
    resolveClientIp(
      new Headers({ "x-forwarded-for": "9.9.9.9, unknown, 192.0.2.9" }),
    ),
  ).toBe("192.0.2.9");
});

test("port suffixes are stripped from single values, bare IPv6 is never split", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  delete process.env.TRUSTED_PROXIES;

  expect(
    resolveClientIp(new Headers({ "x-forwarded-for": "1.2.3.4:56789" })),
  ).toBe("1.2.3.4");
  expect(
    resolveClientIp(new Headers({ "x-forwarded-for": "[2001:db8::5]" })),
  ).toBe(normalizeIP("2001:db8::5", { ipv6Subnet: IPV6_SUBNET_BITS }));
  // RFC 3986 requires brackets for IPv6-with-port, so an unbracketed colon
  // form is inherently an address, not an address:port.
  expect(
    resolveClientIp(new Headers({ "x-forwarded-for": "2001:db8::5:443" })),
  ).toBe(normalizeIP("2001:db8::5:443", { ipv6Subnet: IPV6_SUBNET_BITS }));
});

test("declared-proxy chain walk survives appended ports", () => {
  delete process.env.DEPLOY_TARGET;
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  process.env.TRUSTED_PROXIES = PROXY_IP;

  expect(
    resolveClientIp(
      new Headers({
        "x-forwarded-for": `${CLIENT_IP}:51000, ${PROXY_IP}:443`,
      }),
    ),
  ).toBe(CLIENT_IP);
});

test("stamp: a caller-supplied internal header is always overwritten", () => {
  process.env.DEPLOY_TARGET = "cloudflare";

  const headers = new Headers({
    [INTERNAL_CLIENT_IP_HEADER]: "6.6.6.6",
    "cf-connecting-ip": CLIENT_IP,
  });
  stampClientIpHeader(headers);
  expect(headers.get(INTERNAL_CLIENT_IP_HEADER)).toBe(CLIENT_IP);
});

test("stamp: an unattributable request stamps empty, not the caller's value", () => {
  delete process.env.DEPLOY_TARGET;
  delete process.env.TRUSTED_PROXY_HEADER;

  const headers = new Headers({
    [INTERNAL_CLIENT_IP_HEADER]: "6.6.6.6",
    "x-forwarded-for": CLIENT_IP,
  });
  stampClientIpHeader(headers);
  expect(headers.get(INTERNAL_CLIENT_IP_HEADER)).toBe("");
});
