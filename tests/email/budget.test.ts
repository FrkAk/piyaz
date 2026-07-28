import { test, expect, beforeEach } from "bun:test";
import {
  __resetBudgetForTest,
  getPlatformBudgetStore,
} from "@/lib/email/_budget.node";
import { EMAIL_BUDGET, consumeEmailBudget } from "@/lib/email/budget";

beforeEach(() => __resetBudgetForTest());

test("allows sends up to the budget, then drops", async () => {
  const store = getPlatformBudgetStore()!;
  for (let i = 0; i < EMAIL_BUDGET.max; i++) {
    expect(await store.consume("k", EMAIL_BUDGET.max, 3600)).toBe(true);
  }
  expect(await store.consume("k", EMAIL_BUDGET.max, 3600)).toBe(false);
});

test("separate keys hold independent budgets", async () => {
  const store = getPlatformBudgetStore()!;
  for (let i = 0; i < EMAIL_BUDGET.max; i++) {
    await store.consume("a", EMAIL_BUDGET.max, 3600);
  }
  expect(await store.consume("a", EMAIL_BUDGET.max, 3600)).toBe(false);
  expect(await store.consume("b", EMAIL_BUDGET.max, 3600)).toBe(true);
});

test("window rollover restores the budget", async () => {
  const store = getPlatformBudgetStore()!;
  // A zero-second window expires immediately, so the next consume opens a
  // fresh window rather than waiting out a real hour.
  expect(await store.consume("roll", 1, 0)).toBe(true);
  expect(await store.consume("roll", 1, 0)).toBe(true);
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
  // The node store is the only place keys land; assert via a fresh consume on
  // a key built the same way, which must collide with the hashed entry.
  const store = getPlatformBudgetStore()!;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("secret@example.com"),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `emailbudget:verification:${hex}`;
  expect(key).not.toContain("secret@example.com");
  for (let i = 1; i < EMAIL_BUDGET.max; i++) {
    expect(await store.consume(key, EMAIL_BUDGET.max, 3600)).toBe(true);
  }
  expect(await store.consume(key, EMAIL_BUDGET.max, 3600)).toBe(false);
});
