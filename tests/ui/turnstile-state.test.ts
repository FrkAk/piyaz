import { test, expect } from "bun:test";
import {
  CAPTCHA_RESPONSE_HEADER,
  TURNSTILE_UNAVAILABLE_NOTICE,
  TURNSTILE_UNSUPPORTED_NOTICE,
  turnstileBlockedMessage,
  turnstileFetchOptions,
  turnstileReady,
} from "@/components/auth/turnstile-state";

/**
 * Decision surface shared by every captcha-protected auth form.
 *
 * Extracted from the `useTurnstile` hook so it can be tested without a DOM,
 * matching how the rest of `tests/ui` covers client behavior. These three
 * functions carry the whole security-relevant contract: whether a form may
 * submit, and what reaches the wire when it does.
 */

test("a form with Turnstile configured cannot submit without a token", () => {
  // Fail closed. Failing open here would let anyone bypass the captcha by
  // blocking the script, which is the one thing this gate exists to prevent.
  expect(turnstileReady("0x4AAA", null)).toBe(false);
  expect(turnstileReady("0x4AAA", "tok")).toBe(true);
});

test("a deployment without Turnstile submits exactly as before", () => {
  // Self-host runs with no site key and must keep its original behavior.
  expect(turnstileReady(null, null)).toBe(true);
  expect(turnstileReady(null, "tok")).toBe(true);
});

test("the token travels in the header Better Auth reads it from", () => {
  // The sole contract with the server plugin. A typo here ships a build where
  // every protected submit returns 400 MISSING_RESPONSE.
  expect(CAPTCHA_RESPONSE_HEADER).toBe("x-captcha-response");
  expect(turnstileFetchOptions("tok")).toEqual({
    headers: { "x-captcha-response": "tok" },
  });
});

test("no token means no fetch options, so nothing empty reaches the wire", () => {
  expect(turnstileFetchOptions(null)).toBeUndefined();
});

test("each blocked reason gets its own message", () => {
  const pending = turnstileBlockedMessage("pending");
  const unavailable = turnstileBlockedMessage("unavailable");
  const unsupported = turnstileBlockedMessage("unsupported");
  expect(new Set([pending, unavailable, unsupported]).size).toBe(3);
  // An unsupported browser is terminal: retrying re-runs the same detection,
  // so the copy must not promise that waiting or retrying helps.
  expect(unsupported.toLowerCase()).toContain("browser");
});

test("the strip above the button and the notice below it do not repeat each other", () => {
  // Both are on screen at once after a failed submit: the terse strip answers
  // "why did my click do nothing", the notice answers "what do I do". If a
  // later copy edit collapses them, the visitor reads the same sentence twice.
  const terse = turnstileBlockedMessage("unsupported");
  expect(terse).not.toBe(TURNSTILE_UNSUPPORTED_NOTICE);
  expect(TURNSTILE_UNSUPPORTED_NOTICE.length).toBeGreaterThan(terse.length);
});

test("the unavailable notice names the host a network filter has to allow", () => {
  // The one actionable detail in that copy. A visitor running a filter cannot
  // act on "verification failed"; they can act on a host name.
  expect(TURNSTILE_UNAVAILABLE_NOTICE.host).toBe("challenges.cloudflare.com");
});
