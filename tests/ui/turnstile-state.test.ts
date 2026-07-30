import { test, expect } from "bun:test";
import {
  CAPTCHA_RESPONSE_HEADER,
  TURNSTILE_UNAVAILABLE_NOTICE,
  TURNSTILE_UNSUPPORTED_NOTICE,
  TURNSTILE_VERIFYING_LABEL,
  turnstileBlockedMessage,
  turnstileFetchOptions,
  turnstileTerminal,
} from "@/components/auth/turnstile-state";

/**
 * Decision surface shared by every captcha-protected auth form.
 *
 * Extracted from the `useTurnstile` hook so it can be tested without a DOM,
 * matching how the rest of `tests/ui` covers client behavior. These
 * functions carry the whole security-relevant contract: when submit-time
 * acquisition may wait, and what reaches the wire when it resolves.
 */

test("terminal reasons refuse immediately instead of waiting", () => {
  // Fail closed without spending the wait budget: unavailable and unsupported
  // cannot resolve by waiting, so submit-time acquisition returns null at
  // once. Pending and interactive can resolve, so the widget gets its wait.
  expect(turnstileTerminal("unavailable")).toBe(true);
  expect(turnstileTerminal("unsupported")).toBe(true);
  expect(turnstileTerminal("pending")).toBe(false);
  expect(turnstileTerminal("interactive")).toBe(false);
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
  const interactive = turnstileBlockedMessage("interactive");
  const unavailable = turnstileBlockedMessage("unavailable");
  const unsupported = turnstileBlockedMessage("unsupported");
  expect(new Set([pending, interactive, unavailable, unsupported]).size).toBe(
    4,
  );
  // An unsupported browser is terminal: retrying re-runs the same detection,
  // so the copy must not promise that waiting or retrying helps.
  expect(unsupported.toLowerCase()).toContain("browser");
});

test("pending copy never instructs completing an invisible widget", () => {
  // The original dead end: "Complete the verification" while nothing was on
  // screen. Pending means the background run is still working; only the
  // escalated state may point the visitor at the widget.
  expect(turnstileBlockedMessage("pending").toLowerCase()).not.toContain(
    "complete",
  );
  expect(turnstileBlockedMessage("interactive").toLowerCase()).toContain(
    "complete",
  );
  expect(turnstileBlockedMessage("interactive").toLowerCase()).toContain(
    "below",
  );
});

test("the verifying label is progress copy, not refusal copy", () => {
  const reasons = [
    "pending",
    "interactive",
    "unavailable",
    "unsupported",
  ] as const;
  for (const reason of reasons) {
    expect(TURNSTILE_VERIFYING_LABEL).not.toBe(turnstileBlockedMessage(reason));
  }
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
