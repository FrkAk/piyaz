import { test, expect } from "bun:test";
import { buildCsp, headerRules, securityHeaders } from "@/lib/security/headers";
import buildNextConfig from "@/next.config";

const REQUIRED_KEYS = [
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
  "Cross-Origin-Resource-Policy",
];

test("securityHeaders emits every required always-on key", () => {
  const keys = securityHeaders().map((h) => h.key);
  for (const key of REQUIRED_KEYS) expect(keys).toContain(key);
});

test("securityHeaders never includes CSP or HSTS (those are per-request / host-scoped)", () => {
  const keys = securityHeaders().map((h) => h.key);
  expect(keys).not.toContain("Content-Security-Policy");
  expect(keys).not.toContain("Strict-Transport-Security");
});

test("buildCsp throws when isProd is true without a nonce", () => {
  expect(() => buildCsp({ isProd: true })).toThrow();
});

test("production CSP includes the nonce and 'strict-dynamic' in script-src", () => {
  const csp = buildCsp({ isProd: true, nonce: "abc123" });
  const scriptSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"))!;
  expect(scriptSrc).toContain("'nonce-abc123'");
  expect(scriptSrc).toContain("'strict-dynamic'");
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).not.toContain("'unsafe-eval'");
});

test("dev CSP allows 'unsafe-eval' and 'unsafe-inline' for HMR", () => {
  const csp = buildCsp({ isProd: false });
  const scriptSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"))!;
  expect(scriptSrc).toContain("'unsafe-eval'");
  expect(scriptSrc).toContain("'unsafe-inline'");
});

test("CSP includes connect-src 'self' for same-origin SSE (/api/events)", () => {
  const csp = buildCsp({ isProd: true, nonce: "x" });
  expect(csp).toMatch(/connect-src[^;]*\bself\b/);
});

test("dev CSP additionally allows ws:/wss: in connect-src for HMR", () => {
  const csp = buildCsp({ isProd: false });
  const connectSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"))!;
  expect(connectSrc).toContain("ws:");
  expect(connectSrc).toContain("wss:");
});

test("production CSP allows the same-origin wss origin when supplied (CF realtime)", () => {
  const csp = buildCsp({
    isProd: true,
    nonce: "x",
    wsOrigin: "wss://app.example.com",
  });
  const connectSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"))!;
  expect(connectSrc).toContain("'self'");
  expect(connectSrc).toContain("wss://app.example.com");
  // Same-origin only — never the blanket wss: scheme that would let injected
  // script reach any host.
  expect(connectSrc).not.toMatch(/\bwss:(?!\/\/)/);
});

test("production CSP without wsOrigin keeps connect-src locked to 'self' (self-host)", () => {
  const csp = buildCsp({ isProd: true, nonce: "x" });
  const connectSrc = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src"))!;
  expect(connectSrc).toBe("connect-src 'self'");
});

test("CSP includes frame-ancestors 'none' (clickjacking)", () => {
  const csp = buildCsp({ isProd: true, nonce: "x" });
  expect(csp).toMatch(/frame-ancestors[^;]*'none'/);
});

test("production CSP includes upgrade-insecure-requests", () => {
  const csp = buildCsp({ isProd: true, nonce: "x" });
  expect(csp).toMatch(/(^|;\s*)upgrade-insecure-requests(\s*;|$)/);
});

test("dev CSP omits upgrade-insecure-requests (HMR on http://localhost)", () => {
  const csp = buildCsp({ isProd: false });
  expect(csp).not.toContain("upgrade-insecure-requests");
});

test("headerRules(false) has the always-on security rule and no HSTS", () => {
  const rules = headerRules(false);
  // Security rule + 3 auth-page Cache-Control rules, no HSTS in dev. The
  // count anchor catches an accidentally duplicated or dropped rule; the
  // auth-page values themselves are asserted in tests/auth/cache-control.
  expect(rules).toHaveLength(4);
  // Always-on security headers on every path, never host-scoped.
  const securityRule = rules.find((r) => r.source === "/:path*")!;
  expect(securityRule).toBeTruthy();
  expect(securityRule.missing).toBeUndefined();
  // No rule carries HSTS in dev.
  const hasHsts = rules.some((r) =>
    r.headers.some((h) => h.key === "Strict-Transport-Security"),
  );
  expect(hasHsts).toBe(false);
});

test("headerRules(true) adds a host-scoped HSTS rule", () => {
  const rules = headerRules(true);
  // Security + HSTS + 3 auth-page rules; count anchor guards against a
  // duplicated/missing rule. The single HSTS rule is asserted below; the
  // auth-page Cache-Control values live in tests/auth/cache-control.test.ts.
  expect(rules).toHaveLength(5);
  expect(
    rules.filter((r) =>
      r.headers.some((h) => h.key === "Strict-Transport-Security"),
    ),
  ).toHaveLength(1);
  const hstsRule = rules.find((r) =>
    r.headers.some((h) => h.key === "Strict-Transport-Security"),
  )!;
  expect(hstsRule).toBeTruthy();
  expect(hstsRule.source).toBe("/:path*");
  expect(hstsRule.missing).toBeDefined();
  expect(hstsRule.missing!).toHaveLength(1);
  expect(hstsRule.missing![0]!.type).toBe("host");
});

test("HSTS uses max-age >= 31536000 with includeSubDomains", () => {
  const hstsRule = headerRules(true).find((r) =>
    r.headers.some((h) => h.key === "Strict-Transport-Security"),
  )!;
  const hsts = hstsRule.headers.find(
    (h) => h.key === "Strict-Transport-Security",
  )!;
  const m = hsts.value.match(/max-age=(\d+)/);
  expect(m).toBeTruthy();
  expect(Number(m![1])).toBeGreaterThanOrEqual(31536000);
  expect(hsts.value).toContain("includeSubDomains");
});

test("HSTS host exclusion matches loopback names but not real domains", () => {
  const hstsRule = headerRules(true).find((r) =>
    r.headers.some((h) => h.key === "Strict-Transport-Security"),
  )!;
  const regex = new RegExp(hstsRule.missing![0]!.value);
  expect(regex.test("localhost")).toBe(true);
  expect(regex.test("localhost:3000")).toBe(true);
  expect(regex.test("127.0.0.1")).toBe(true);
  expect(regex.test("127.0.0.1:3000")).toBe(true);
  expect(regex.test("[::1]")).toBe(true);
  expect(regex.test("[::1]:3000")).toBe(true);
  expect(regex.test("piyaz.ai")).toBe(false);
  expect(regex.test("evil-localhost.com")).toBe(false);
  expect(regex.test("127.0.0.1.evil.com")).toBe(false);
});

test("nextConfig disables X-Powered-By", async () => {
  const nextConfig = await buildNextConfig();
  expect(nextConfig.poweredByHeader).toBe(false);
});

test("nextConfig.headers() emits no CSP (CSP is set by middleware)", async () => {
  const nextConfig = await buildNextConfig();
  const rules = await nextConfig.headers!();
  for (const rule of rules) {
    const keys = rule.headers.map((h) => h.key);
    expect(keys).not.toContain("Content-Security-Policy");
  }
});

test("nextConfig.headers() applies the always-on rule to /:path*", async () => {
  const nextConfig = await buildNextConfig();
  const rules = await nextConfig.headers!();
  expect(rules.length).toBeGreaterThanOrEqual(1);
  expect(rules[0]!.source).toBe("/:path*");
  const keys = rules[0]!.headers.map((h) => h.key);
  for (const key of REQUIRED_KEYS) expect(keys).toContain(key);
});
