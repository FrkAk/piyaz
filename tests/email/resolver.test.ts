import { test, expect, beforeEach, afterAll, mock } from "bun:test";
import { LogSender } from "@/lib/email/log-sender";
import type { EmailSender } from "@/lib/email/types";

/**
 * Platform sender the mocked `@/lib/email/_sender` indirection returns.
 * `null` matches the real node stub's behavior, so the process-global
 * `mock.module` (unrestoreable per Bun docs) is behavior-preserving for any
 * later test file that imports the indirection while this stays `null`.
 * Flipped to a stub sender to exercise the cloudflare branch of
 * `getEmailSender()` without a Workers runtime.
 */
let _platformSender: EmailSender | null = null;
let _platformConfigured = false;

mock.module("@/lib/email/_sender", () => ({
  getPlatformSender: () => _platformSender,
  platformEmailConfigured: () => _platformConfigured,
}));

const { getEmailSender, isEmailEnabled, isEmailConfiguredAtBoot } =
  await import("@/lib/email");

const ORIGINAL_EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT;

const stubSender: EmailSender = {
  send: async () => ({ kind: "ok" }),
};

beforeEach(() => {
  _platformSender = null;
  _platformConfigured = false;
  delete process.env.EMAIL_TRANSPORT;
});

afterAll(() => {
  _platformSender = null;
  _platformConfigured = false;
  if (ORIGINAL_EMAIL_TRANSPORT === undefined)
    delete process.env.EMAIL_TRANSPORT;
  else process.env.EMAIL_TRANSPORT = ORIGINAL_EMAIL_TRANSPORT;
});

test("log branch: EMAIL_TRANSPORT=log resolves a LogSender", () => {
  process.env.EMAIL_TRANSPORT = "log";
  expect(getEmailSender()).toBeInstanceOf(LogSender);
});

test("log branch: EMAIL_TRANSPORT=log wins over a configured platform sender", () => {
  process.env.EMAIL_TRANSPORT = "log";
  _platformSender = stubSender;
  expect(getEmailSender()).toBeInstanceOf(LogSender);
});

test("null branch: no transport configured resolves null and disables email", () => {
  expect(getEmailSender()).toBeNull();
  expect(isEmailEnabled()).toBe(false);
});

test("cloudflare branch: delegates to the platform sender and enables email", () => {
  _platformSender = stubSender;
  expect(getEmailSender()).toBe(stubSender);
  expect(isEmailEnabled()).toBe(true);
});

test("boot signal: EMAIL_TRANSPORT=log configures email at boot", () => {
  process.env.EMAIL_TRANSPORT = "log";
  expect(isEmailConfiguredAtBoot()).toBe(true);
});

test("boot signal: a configured platform configures email at boot", () => {
  _platformConfigured = true;
  expect(isEmailConfiguredAtBoot()).toBe(true);
});

test("boot signal: neither transport nor platform means unconfigured", () => {
  expect(isEmailConfiguredAtBoot()).toBe(false);
});
