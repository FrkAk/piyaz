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

// The mock must carry the real module's full export surface: `_budget.ts`
// star-re-exports `_budget.node`, so dropping `__resetBudgetForTest` here
// would hand `undefined` to any later file importing it through the bare
// module.
mock.module("@/lib/email/_budget", () => ({
  getPlatformBudgetStore: () =>
    _storeOverride === undefined ? nodeStore : _storeOverride,
  __resetBudgetForTest,
}));

const { EMAIL_BUDGET, emailBudgetMax, reserveEmailBudget } = await import(
  "@/lib/email/budget"
);

/**
 * Reserve a slot and immediately record the send, the shape a successful
 * delivery produces.
 *
 * @param to - Recipient address.
 * @param template - Template name.
 * @returns `true` when the send was within budget.
 */
async function sendOnce(to: string, template: string): Promise<boolean> {
  const slot = await reserveEmailBudget(to, template);
  if (slot === null) return false;
  await slot.commit();
  return true;
}

beforeEach(() => __resetBudgetForTest());

afterEach(() => {
  _storeOverride = undefined;
});

test("the shipped caps are the ones the threat model was sized against", () => {
  // Pinned deliberately: every other assertion here reads the constants
  // symbolically, so without this a cap of 1000 would pass the whole suite.
  expect(EMAIL_BUDGET.defaultMax).toBe(3);
  expect(EMAIL_BUDGET.windowSeconds).toBe(3600);
});

test("team invitations carry a larger cap than the default", () => {
  // An invite mails an address the sender chose, so it stays bounded, but a
  // person joining several teams in an hour must not silently stop receiving
  // them the way a flat cap would.
  expect(emailBudgetMax("teamInvite")).toBeGreaterThan(EMAIL_BUDGET.defaultMax);
  expect(emailBudgetMax("verification")).toBe(EMAIL_BUDGET.defaultMax);
});

test("allows sends up to the budget, then drops", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    expect(await sendOnce("user@example.com", "verification")).toBe(true);
  }
  expect(await sendOnce("user@example.com", "verification")).toBe(false);
});

test("a reserved slot that is never committed leaves the budget untouched", async () => {
  // The whole point of splitting reserve from commit: a send that fails at the
  // provider must not burn the recipient's allowance. Three provider outages
  // would otherwise lock a real user out of verification for an hour.
  for (let i = 0; i < EMAIL_BUDGET.defaultMax + 5; i++) {
    expect(
      await reserveEmailBudget("flaky@example.com", "verification"),
    ).not.toBeNull();
  }
  expect(await sendOnce("flaky@example.com", "verification")).toBe(true);
});

test("separate keys hold independent budgets", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    await nodeStore.commit("a", i, 3600);
  }
  expect(await nodeStore.read("a")).toBe(EMAIL_BUDGET.defaultMax);
  expect(await nodeStore.read("b")).toBe(0);
});

test("window rollover restores the budget", async () => {
  // A zero-second window expires immediately, so the next read opens a fresh
  // window rather than waiting out a real hour.
  await nodeStore.commit("roll", 0, 0);
  expect(await nodeStore.read("roll")).toBe(0);
});

test("budget is scoped per template, so one template cannot starve another", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    expect(await sendOnce("user@example.com", "verification")).toBe(true);
  }
  expect(await sendOnce("user@example.com", "verification")).toBe(false);
  expect(await sendOnce("user@example.com", "new-sign-in")).toBe(true);
});

test("recipient address is normalized, so case and padding cannot mint a fresh budget", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    await sendOnce("victim@example.com", "verification");
  }
  expect(await sendOnce("  Victim@Example.COM  ", "verification")).toBe(false);
});

test("distinct recipients hold independent budgets", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    await sendOnce("one@example.com", "verification");
  }
  expect(await sendOnce("one@example.com", "verification")).toBe(false);
  expect(await sendOnce("two@example.com", "verification")).toBe(true);
});

test("the key handed to the store carries a digest, never the address", async () => {
  const seen: string[] = [];
  _storeOverride = {
    async read(key) {
      seen.push(key);
      return 0;
    },
    async commit() {},
  };

  await sendOnce("secret@example.com", "verification");

  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toContain("secret@example.com");
  expect(seen[0]).not.toContain("secret");
  expect(seen[0]).toMatch(/^emailbudget:verification:[0-9a-f]{64}$/);
});

test("no resolvable store fails open, so a counter outage never blocks verification", async () => {
  // Mirrors an unbound AUTH_KV or a call outside a request context. Losing the
  // counter must degrade to "the email still sends", never to "nobody can
  // verify their address".
  _storeOverride = null;
  for (let i = 0; i < EMAIL_BUDGET.defaultMax + 2; i++) {
    expect(await sendOnce("nobudget@example.com", "verification")).toBe(true);
  }
});
