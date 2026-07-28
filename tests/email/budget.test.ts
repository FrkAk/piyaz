import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  __resetBudgetForTest,
  getPlatformBudgetStore,
} from "@/lib/email/_budget.node";
import type { EmailBudgetStore } from "@/lib/email/budget-types";

/**
 * Per-recipient send budget: the node store's counting behavior and the
 * policy layer's keying (`lib/email/budget.ts`).
 *
 * `_storeOverride` stays undefined by default so the module mock below
 * delegates to the real node store. `mock.module` is process-global and
 * unrestoreable (see `tests/email/resolver.test.ts`), so a mock returning a
 * fixed value would silently disable the budget for every test file running
 * after this one. That is exactly how the fail-open case below first broke
 * `tests/email/auth-email-failure.test.ts` in CI but not locally, where the
 * file order differed.
 *
 * The real store is captured BEFORE `mock.module` runs. When another test
 * file has already loaded the real `_budget` re-export chain, the mock
 * patches the shared export binding, so a factory that called
 * `getPlatformBudgetStore()` at consume time would invoke itself and spin
 * the process (tail call, so no stack overflow to fail on).
 */
const nodeStore = getPlatformBudgetStore()!;

let _storeOverride: EmailBudgetStore | null | undefined;

mock.module("@/lib/email/_budget", () => ({
  getPlatformBudgetStore: () =>
    _storeOverride === undefined ? nodeStore : _storeOverride,
}));

const { EMAIL_BUDGET, consumeEmailBudget } = await import("@/lib/email/budget");

beforeEach(() => __resetBudgetForTest());

afterEach(() => {
  _storeOverride = undefined;
});

test("allows sends up to the budget, then drops", async () => {
  for (let i = 0; i < EMAIL_BUDGET.max; i++) {
    expect(await nodeStore.consume("k", EMAIL_BUDGET.max, 3600)).toBe(true);
  }
  expect(await nodeStore.consume("k", EMAIL_BUDGET.max, 3600)).toBe(false);
});

test("separate keys hold independent budgets", async () => {
  for (let i = 0; i < EMAIL_BUDGET.max; i++) {
    await nodeStore.consume("a", EMAIL_BUDGET.max, 3600);
  }
  expect(await nodeStore.consume("a", EMAIL_BUDGET.max, 3600)).toBe(false);
  expect(await nodeStore.consume("b", EMAIL_BUDGET.max, 3600)).toBe(true);
});

test("window rollover restores the budget", async () => {
  // A zero-second window expires immediately, so the next consume opens a
  // fresh window rather than waiting out a real hour.
  expect(await nodeStore.consume("roll", 1, 0)).toBe(true);
  expect(await nodeStore.consume("roll", 1, 0)).toBe(true);
});

test("budget is scoped per template, so one template cannot starve another", async () => {
  for (let i = 0; i < EMAIL_BUDGET.max; i++) {
    expect(await consumeEmailBudget("user@example.com", "verification")).toBe(
      true,
    );
  }
  expect(await consumeEmailBudget("user@example.com", "verification")).toBe(
    false,
  );
  expect(await consumeEmailBudget("user@example.com", "new-sign-in")).toBe(
    true,
  );
});

test("recipient address is normalized, so case and padding cannot mint a fresh budget", async () => {
  for (let i = 0; i < EMAIL_BUDGET.max; i++) {
    await consumeEmailBudget("victim@example.com", "verification");
  }
  expect(
    await consumeEmailBudget("  Victim@Example.COM  ", "verification"),
  ).toBe(false);
});

test("distinct recipients hold independent budgets", async () => {
  for (let i = 0; i < EMAIL_BUDGET.max; i++) {
    await consumeEmailBudget("one@example.com", "verification");
  }
  expect(await consumeEmailBudget("one@example.com", "verification")).toBe(
    false,
  );
  expect(await consumeEmailBudget("two@example.com", "verification")).toBe(
    true,
  );
});

test("the budget key never contains the raw address", async () => {
  await consumeEmailBudget("secret@example.com", "verification");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("secret@example.com"),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `emailbudget:verification:${hex}`;
  expect(key).not.toContain("secret@example.com");
  // Colliding with the entry the call above created proves the policy layer
  // keys on this digest and never on the address itself.
  for (let i = 1; i < EMAIL_BUDGET.max; i++) {
    expect(await nodeStore.consume(key, EMAIL_BUDGET.max, 3600)).toBe(true);
  }
  expect(await nodeStore.consume(key, EMAIL_BUDGET.max, 3600)).toBe(false);
});

test("no resolvable store fails open, so a counter outage never blocks verification", async () => {
  // Mirrors an unbound AUTH_KV or a call outside a request context. Losing the
  // counter must degrade to "the email still sends", never to "nobody can
  // verify their address".
  _storeOverride = null;
  for (let i = 0; i < EMAIL_BUDGET.max + 2; i++) {
    expect(
      await consumeEmailBudget("nobudget@example.com", "verification"),
    ).toBe(true);
  }
});
