import { test, expect, beforeEach, afterEach } from "bun:test";
import { resolveBrandConfig, senderFor } from "@/lib/email/brand";

const KEYS = [
  "APP_NAME",
  "BETTER_AUTH_URL",
  "BRAND_LOGO_URL",
  "BRAND_COLOR",
  "BRAND_FOOTER_LINKS",
  "EMAIL_REPLY_TO",
  "EMAIL_FROM",
  "EMAIL_FROM_NOREPLY",
  "EMAIL_FROM_SUPPORT",
  "EMAIL_FROM_INFO",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const original = saved.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test("neutral defaults: brand vars unset yield undefined presentation fields and a host appName", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  const brand = resolveBrandConfig();

  expect(brand.logoUrl).toBeUndefined();
  expect(brand.brandColor).toBeUndefined();
  expect(brand.footerLinks).toBeUndefined();
  expect(brand.supportEmail).toBeUndefined();
  expect(brand.appName).toBe("tasks.acme.example");
  expect(brand.appName).not.toBe("Piyaz");
});

test("neutral defaults: no resolved field contains piyaz.ai", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  const brand = resolveBrandConfig();

  expect(JSON.stringify(brand)).not.toContain("piyaz.ai");
});

test("appUrl and appName fall back to localhost when BETTER_AUTH_URL is unset", () => {
  const brand = resolveBrandConfig();

  expect(brand.appUrl).toBe("http://localhost:3000");
  expect(brand.appName).toBe("localhost");
});

test("malformed BETTER_AUTH_URL yields a localhost appName without throwing", () => {
  process.env.BETTER_AUTH_URL = "not a url";
  const brand = resolveBrandConfig();

  expect(brand.appName).toBe("localhost");
});

test("malformed BETTER_AUTH_URL yields the fallback appUrl, not the raw string", () => {
  process.env.BETTER_AUTH_URL = "not a url";
  const brand = resolveBrandConfig();

  expect(brand.appUrl).toBe("http://localhost:3000");
});

test("branded render: each brand var surfaces on the resolved config", () => {
  process.env.APP_NAME = "Acme Tasks";
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.BRAND_LOGO_URL = "https://cdn.acme.example/logo.png";
  process.env.BRAND_COLOR = "#123456";
  process.env.BRAND_FOOTER_LINKS = JSON.stringify([
    { label: "Home", url: "https://acme.example" },
  ]);
  process.env.EMAIL_REPLY_TO = "help@acme.example";

  const brand = resolveBrandConfig();

  expect(brand.appName).toBe("Acme Tasks");
  expect(brand.logoUrl).toBe("https://cdn.acme.example/logo.png");
  expect(brand.brandColor).toBe("#123456");
  expect(brand.footerLinks).toEqual([
    { label: "Home", url: "https://acme.example" },
  ]);
  expect(brand.supportEmail).toBe("help@acme.example");
});

test("malformed BRAND_FOOTER_LINKS yields undefined without throwing", () => {
  process.env.BRAND_FOOTER_LINKS = "{ not json";
  expect(resolveBrandConfig().footerLinks).toBeUndefined();

  process.env.BRAND_FOOTER_LINKS = JSON.stringify({ label: "x", url: "y" });
  expect(resolveBrandConfig().footerLinks).toBeUndefined();

  process.env.BRAND_FOOTER_LINKS = JSON.stringify([{ label: "x" }]);
  expect(resolveBrandConfig().footerLinks).toBeUndefined();
});

test("footer links with blank label or url are dropped", () => {
  process.env.BRAND_FOOTER_LINKS = JSON.stringify([
    { label: "", url: "" },
    { label: "Home", url: "   " },
    { label: "  ", url: "https://acme.example" },
  ]);
  expect(resolveBrandConfig().footerLinks).toBeUndefined();

  process.env.BRAND_FOOTER_LINKS = JSON.stringify([
    { label: "", url: "" },
    { label: "Home", url: "https://acme.example" },
  ]);
  expect(resolveBrandConfig().footerLinks).toEqual([
    { label: "Home", url: "https://acme.example" },
  ]);
});

test("footer links are trimmed and stripped to label and url", () => {
  process.env.BRAND_FOOTER_LINKS = JSON.stringify([
    { label: " Home ", url: " https://acme.example ", tracking: "x" },
  ]);
  expect(resolveBrandConfig().footerLinks).toEqual([
    { label: "Home", url: "https://acme.example" },
  ]);
});

test("footer links keep only https and mailto urls", () => {
  process.env.BRAND_FOOTER_LINKS = JSON.stringify([
    { label: "Home", url: "javascript:alert(1)" },
    { label: "Docs", url: "ftp://acme.example" },
    { label: "Plain", url: "http://acme.example" },
  ]);
  expect(resolveBrandConfig().footerLinks).toBeUndefined();

  process.env.BRAND_FOOTER_LINKS = JSON.stringify([
    { label: "Support", url: "mailto:help@acme.example" },
  ]);
  expect(resolveBrandConfig().footerLinks).toEqual([
    { label: "Support", url: "mailto:help@acme.example" },
  ]);
});

test("invalid BRAND_COLOR degrades to undefined", () => {
  for (const color of [
    "red",
    "#12345g",
    "#12345",
    "0f172a",
    "#abcd",
    "#12345678",
  ]) {
    process.env.BRAND_COLOR = color;
    expect(resolveBrandConfig().brandColor).toBeUndefined();
  }

  process.env.BRAND_COLOR = "#abc";
  expect(resolveBrandConfig().brandColor).toBe("#abc");
});

test("non-https BRAND_LOGO_URL degrades to undefined", () => {
  for (const url of [
    "javascript:alert(1)",
    "not a url",
    "data:image/png;base64,x",
    "http://cdn.acme.example/logo.png",
  ]) {
    process.env.BRAND_LOGO_URL = url;
    expect(resolveBrandConfig().logoUrl).toBeUndefined();
  }
});

test("blank env var is treated as unset", () => {
  process.env.APP_NAME = "   ";
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  expect(resolveBrandConfig().appName).toBe("tasks.acme.example");
});

test("transactional uses the no-reply address and has no replyTo", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.EMAIL_FROM_NOREPLY = "noreply@acme.example";

  const sender = senderFor("transactional");
  expect(sender.from).toBe("noreply@acme.example");
  expect(sender.replyTo).toBeUndefined();
});

test("personal uses the support from-address and replyTo equals EMAIL_REPLY_TO when set", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.EMAIL_FROM_SUPPORT = "hello@acme.example";
  process.env.EMAIL_REPLY_TO = "help@acme.example";

  const sender = senderFor("personal");
  expect(sender.from).toBe("hello@acme.example");
  expect(sender.replyTo).toBe("help@acme.example");
});

test("personal always returns a replyTo, defaulting to the from-address", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.EMAIL_FROM_SUPPORT = "hello@acme.example";

  const sender = senderFor("personal");
  expect(sender.from).toBe("hello@acme.example");
  expect(sender.replyTo).toBe("hello@acme.example");
});

test("informational uses the info address and has no replyTo", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.EMAIL_FROM_INFO = "info@acme.example";

  const sender = senderFor("informational");
  expect(sender.from).toBe("info@acme.example");
  expect(sender.replyTo).toBeUndefined();
});

test("every purpose falls back to EMAIL_FROM when the per-purpose vars are unset", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.EMAIL_FROM = "mail@acme.example";

  expect(senderFor("transactional").from).toBe("mail@acme.example");
  expect(senderFor("personal").from).toBe("mail@acme.example");
  expect(senderFor("informational").from).toBe("mail@acme.example");
});

test("per-purpose vars beat EMAIL_FROM when both are set", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.EMAIL_FROM = "mail@acme.example";
  process.env.EMAIL_FROM_NOREPLY = "noreply@acme.example";
  process.env.EMAIL_FROM_SUPPORT = "hello@acme.example";
  process.env.EMAIL_FROM_INFO = "info@acme.example";

  expect(senderFor("transactional").from).toBe("noreply@acme.example");
  expect(senderFor("personal").from).toBe("hello@acme.example");
  expect(senderFor("informational").from).toBe("info@acme.example");
});

test("an out-of-union purpose falls back to the from-address instead of returning undefined", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";
  process.env.EMAIL_FROM = "mail@acme.example";

  const sender = senderFor("unknown" as Parameters<typeof senderFor>[0]);
  expect(sender.from).toBe("mail@acme.example");
  expect(sender.replyTo).toBeUndefined();
});

test("fully unconfigured from-address is noreply@<host> and never @piyaz.ai", () => {
  process.env.BETTER_AUTH_URL = "https://tasks.acme.example";

  for (const purpose of [
    "transactional",
    "personal",
    "informational",
  ] as const) {
    const { from } = senderFor(purpose);
    expect(from).toBe("noreply@tasks.acme.example");
    expect(from).not.toContain("piyaz.ai");
  }
});
