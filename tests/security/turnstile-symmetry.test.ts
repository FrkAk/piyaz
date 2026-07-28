import { test, expect } from "bun:test";
import { turnstileSymmetryFailures } from "@/scripts/turnstile-symmetry";

/**
 * Deploy guard for the two Turnstile keys, which arrive by different routes:
 * the secret at runtime via `wrangler secret`, the site key at build time via
 * `next.config.ts`'s `env` block. They can drift apart, and either half alone
 * is worse than having Turnstile off, so the rule is symmetric.
 *
 * Extracted from `assert-deploy-ready.ts` because that script is top-level
 * side-effecting and shells out to wrangler, so neither direction of the rule
 * could be covered where it used to live.
 */

test("both keys present is a healthy deploy", () => {
  expect(
    turnstileSymmetryFailures({
      env: "production",
      secretPresent: true,
      siteKeyPresent: true,
    }),
  ).toEqual([]);
});

test("both keys absent is the documented rollback state and passes", () => {
  // A Turnstile outage fails closed twice, so the rollback lever is to drop
  // BOTH halves and redeploy. That state must not be rejected.
  expect(
    turnstileSymmetryFailures({
      env: "production",
      secretPresent: false,
      siteKeyPresent: false,
    }),
  ).toEqual([]);
});

test("secret without site key is rejected", () => {
  // The plugin arms server-side with no widget to mint a token, so every
  // sign-up and sign-in 400s.
  const failures = turnstileSymmetryFailures({
    env: "production",
    secretPresent: true,
    siteKeyPresent: false,
  });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("TURNSTILE_SITE_KEY");
});

test("site key without secret is rejected", () => {
  // The widget mints tokens nobody verifies: bot protection silently off
  // while appearing on, which is the worse of the two failures.
  const failures = turnstileSymmetryFailures({
    env: "production",
    secretPresent: false,
    siteKeyPresent: true,
  });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("TURNSTILE_SECRET_KEY");
});

test("the failure names the environment it checked", () => {
  // Prod and dev carry different widgets and separate secrets, so a message
  // that always said "production" would send someone to the wrong env.
  const failures = turnstileSymmetryFailures({
    env: "dev",
    secretPresent: true,
    siteKeyPresent: false,
  });
  expect(failures[0]).toContain("dev");
  expect(failures[0]).not.toContain("production");
});
