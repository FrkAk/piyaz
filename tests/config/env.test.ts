import { test, expect, afterEach } from "bun:test";
import { parseEnvInt, signupsDisabled } from "@/lib/config/env";
import pkg from "@/package.json";

test("parses a plain non-negative integer", () => {
  expect(parseEnvInt("42", 7)).toBe(42);
});

test("honors an explicit zero instead of treating it as unset", () => {
  // Operator-facing limits use 0 as a hard freeze; the naive
  // `Number(x) || fallback` pattern would silently discard it.
  expect(parseEnvInt("0", 7)).toBe(0);
});

test("falls back when unset or blank", () => {
  expect(parseEnvInt(undefined, 7)).toBe(7);
  expect(parseEnvInt("", 7)).toBe(7);
  expect(parseEnvInt("   ", 7)).toBe(7);
});

test("falls back on malformed, negative, or non-finite values", () => {
  expect(parseEnvInt("not-a-number", 7)).toBe(7);
  expect(parseEnvInt("-1", 7)).toBe(7);
  expect(parseEnvInt("Infinity", 7)).toBe(7);
  expect(parseEnvInt("NaN", 7)).toBe(7);
});

test("truncates fractional values to integers", () => {
  expect(parseEnvInt("1.9", 7)).toBe(1);
});

const ORIGINAL_TARGET = process.env.NEXT_PUBLIC_DEPLOY_TARGET;
const ORIGINAL_ENABLED = process.env.NEXT_PUBLIC_SIGNUPS_ENABLED;

/**
 * Set the two signup-gate env vars (undefined deletes), so each case exercises
 * a distinct deploy shape.
 *
 * @param target - `NEXT_PUBLIC_DEPLOY_TARGET` value, or undefined to unset.
 * @param enabled - `NEXT_PUBLIC_SIGNUPS_ENABLED` value, or undefined to unset.
 */
function setSignupEnv(
  target: string | undefined,
  enabled: string | undefined,
): void {
  if (target === undefined) delete process.env.NEXT_PUBLIC_DEPLOY_TARGET;
  else process.env.NEXT_PUBLIC_DEPLOY_TARGET = target;
  if (enabled === undefined) delete process.env.NEXT_PUBLIC_SIGNUPS_ENABLED;
  else process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = enabled;
}

afterEach(() => {
  setSignupEnv(ORIGINAL_TARGET, ORIGINAL_ENABLED);
});

test("signup open on self-host (no Cloudflare target)", () => {
  setSignupEnv(undefined, undefined);
  expect(signupsDisabled()).toBe(false);
});

test("signup open on a hosted build with the explicit opt-in", () => {
  setSignupEnv("cloudflare", "true");
  expect(signupsDisabled()).toBe(false);
});

test("signup disabled on a hosted build without the opt-in", () => {
  setSignupEnv("cloudflare", undefined);
  expect(signupsDisabled()).toBe(true);
});

test("signup disabled on a misconfigured hosted build (opt-in not 'true')", () => {
  setSignupEnv("cloudflare", "false");
  expect(signupsDisabled()).toBe(true);
});

/**
 * Hosted scripts that must ship open signup. `signupsDisabled()` fails closed,
 * so one of these losing `SIGNUPS_ENABLED=true` serves the invite-only waitlist
 * instead of the sign-up form, with no build or deploy error to catch it.
 */
const OPEN_SIGNUP_SCRIPTS = ["deploy:cf", "deploy:cf:dev", "preview:cf"];

for (const name of OPEN_SIGNUP_SCRIPTS) {
  test(`${name} carries the signup opt-in into next build`, () => {
    // The flag is inlined as NEXT_PUBLIC_*, so only the build step decides the
    // baked value; setting it on the deploy step alone would be a no-op.
    expect(pkg.scripts[name as keyof typeof pkg.scripts]).toContain(
      "SIGNUPS_ENABLED=true DEPLOY_TARGET=cloudflare next build",
    );
  });
}
