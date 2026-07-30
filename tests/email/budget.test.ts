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

const {
  EMAIL_BUDGET,
  emailBudgetMax,
  emailCooldownSeconds,
  probeEmailSend,
  reserveEmailBudget,
} = await import("@/lib/email/budget");

/**
 * Reserve a slot and immediately record the send, the shape a successful
 * delivery produces.
 *
 * @param to - Recipient address.
 * @param template - Template name.
 * @returns `true` when the send went out.
 */
async function sendOnce(to: string, template: string): Promise<boolean> {
  const decision = await reserveEmailBudget(to, template);
  if (!decision.allowed) return false;
  await decision.slot.commit();
  return true;
}

/**
 * A template with no cooldown, so a test about the hourly cap can spend the
 * whole allowance in one loop without the minimum gap deciding the outcome.
 */
const UNCOOLED = "newSignIn";

beforeEach(() => __resetBudgetForTest());

afterEach(() => {
  _storeOverride = undefined;
});

test("the shipped caps are the ones the threat model was sized against", () => {
  // Pinned deliberately: every other assertion here reads the constants
  // symbolically, so without this a cap of 1000 would pass the whole suite.
  expect(EMAIL_BUDGET.defaultMax).toBe(3);
  expect(EMAIL_BUDGET.windowSeconds).toBe(3600);
  // At or above KV's expirationTtl floor, which the Workers store clamps to.
  expect(emailCooldownSeconds("verification")).toBeGreaterThanOrEqual(60);
  expect(emailCooldownSeconds("passwordReset")).toBeGreaterThanOrEqual(60);
});

test("team invitations carry a larger cap than the default", () => {
  // An invite mails an address the sender chose, so it stays bounded, but a
  // person joining several teams in an hour must not silently stop receiving
  // them the way a flat cap would.
  expect(emailBudgetMax("teamInvite")).toBeGreaterThan(EMAIL_BUDGET.defaultMax);
  expect(emailBudgetMax("verification")).toBe(EMAIL_BUDGET.defaultMax);
});

test("templates whose sends follow a real state change carry no cooldown", async () => {
  // A cooldown on these would suppress a second genuine alert, and on invites
  // it would truncate the same legitimate burst the raised cap exists for.
  expect(emailCooldownSeconds("teamInvite")).toBe(0);
  expect(emailCooldownSeconds("newSignIn")).toBe(0);
  expect(emailCooldownSeconds("passwordChanged")).toBe(0);
  expect(await sendOnce("colleague@example.com", "teamInvite")).toBe(true);
  expect(await sendOnce("colleague@example.com", "teamInvite")).toBe(true);
});

test("allows sends up to the budget, then drops", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    expect(await sendOnce("user@example.com", UNCOOLED)).toBe(true);
  }
  expect(await sendOnce("user@example.com", UNCOOLED)).toBe(false);
});

test("a second send inside the cooldown is withheld, and says why", async () => {
  // The defect this closes: three sign-in attempts used to mail three links in
  // seconds and empty the hour's allowance before the user read the first.
  expect(await sendOnce("typo@example.com", "verification")).toBe(true);
  const second = await reserveEmailBudget("typo@example.com", "verification");
  expect(second.allowed).toBe(false);
  if (second.allowed) throw new Error("expected the send to be withheld");
  expect(second.reason).toBe("cooldown");
});

test("a caller under both caps hears the longer-lived one", async () => {
  // The state every recipient lands in for the minute after their third send.
  // Reporting the cooldown there would tell them to wait a minute when the
  // budget stays spent for the rest of the hour. Driven through a store rather
  // than by sending, because reproducing it live means waiting out the gap.
  _storeOverride = {
    async read() {
      return emailBudgetMax("verification");
    },
    async commit() {},
  };
  const decision = await reserveEmailBudget(
    "spent@example.com",
    "verification",
  );
  expect(decision.allowed).toBe(false);
  if (decision.allowed) throw new Error("expected the send to be withheld");
  expect(decision.reason).toBe("budget");
});

test("password reset carries the cooldown too, not just verification", async () => {
  // Same shape of endpoint: unauthenticated, re-sends to a caller-named address
  // on every call. A cooldown on only one of the two leaves the other floodable
  // up to its hourly cap in a single burst.
  expect(await sendOnce("forgot@example.com", "passwordReset")).toBe(true);
  expect(await sendOnce("forgot@example.com", "passwordReset")).toBe(false);
});

test("the probe reports the same verdict without spending the allowance", async () => {
  // The honest-response path reads through this, so a probe that consumed a
  // send would cost the user the very link the message tells them to wait for.
  expect(await probeEmailSend("probe@example.com", "verification")).toBeNull();
  expect(await sendOnce("probe@example.com", "verification")).toBe(true);
  expect(await probeEmailSend("probe@example.com", "verification")).toBe(
    "cooldown",
  );
  expect(await probeEmailSend("probe@example.com", "verification")).toBe(
    "cooldown",
  );
});

test("a reserved slot that is never committed leaves the budget untouched", async () => {
  // The whole point of splitting reserve from commit: a send that fails at the
  // provider must not burn the recipient's allowance. Three provider outages
  // would otherwise lock a real user out of verification for an hour.
  for (let i = 0; i < EMAIL_BUDGET.defaultMax + 5; i++) {
    const decision = await reserveEmailBudget(
      "flaky@example.com",
      "verification",
    );
    expect(decision.allowed).toBe(true);
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
    expect(await sendOnce("user@example.com", UNCOOLED)).toBe(true);
  }
  expect(await sendOnce("user@example.com", UNCOOLED)).toBe(false);
  expect(await sendOnce("user@example.com", "verification")).toBe(true);
});

test("recipient address is normalized, so case and padding cannot mint a fresh budget", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    await sendOnce("victim@example.com", UNCOOLED);
  }
  expect(await sendOnce("  Victim@Example.COM  ", UNCOOLED)).toBe(false);
});

test("the cooldown is keyed on the same normalized address as the budget", async () => {
  // Otherwise a re-send with different padding would sail past the gap.
  expect(await sendOnce("victim@example.com", "verification")).toBe(true);
  expect(await sendOnce("  Victim@Example.COM  ", "verification")).toBe(false);
});

test("distinct recipients hold independent budgets", async () => {
  for (let i = 0; i < EMAIL_BUDGET.defaultMax; i++) {
    await sendOnce("one@example.com", UNCOOLED);
  }
  expect(await sendOnce("one@example.com", UNCOOLED)).toBe(false);
  expect(await sendOnce("two@example.com", UNCOOLED)).toBe(true);
});

test("every key handed to the store carries a digest, never the address", async () => {
  const seen: string[] = [];
  _storeOverride = {
    async read(key) {
      seen.push(key);
      return 0;
    },
    async commit(key) {
      seen.push(key);
    },
  };

  await sendOnce("secret@example.com", "verification");

  // Cooldown and budget, each read then committed.
  expect(seen).toHaveLength(4);
  for (const key of seen) {
    expect(key).not.toContain("secret@example.com");
    expect(key).not.toContain("secret");
    expect(key).toMatch(/^email(budget|cooldown):verification:[0-9a-f]{64}$/);
  }
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
