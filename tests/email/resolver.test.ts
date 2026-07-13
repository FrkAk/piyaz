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

mock.module("@/lib/email/_sender", () => ({
  getPlatformSender: () => _platformSender,
}));

const { getEmailSender, isEmailEnabled } = await import("@/lib/email");

const ORIGINAL_EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT;

const stubSender: EmailSender = {
  send: async () => ({ kind: "ok" }),
};

beforeEach(() => {
  _platformSender = null;
  delete process.env.EMAIL_TRANSPORT;
});

afterAll(() => {
  _platformSender = null;
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
