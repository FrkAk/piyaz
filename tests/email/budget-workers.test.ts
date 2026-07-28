import { test, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";

/**
 * Cloudflare KV email budget store (`lib/email/_budget.workers.ts`): the
 * read/commit split, the TTL floor, fail-open on KV errors in both directions,
 * and the warn-once missing-binding path. Mirrors
 * `tests/email/sender-workers.test.ts`.
 */

/** Recorded `put` call shape for assertions. */
interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

const _kvData = new Map<string, string>();
const _putCalls: PutCall[] = [];
let _kvThrows = false;

const fakeKv = {
  async get(key: string, _options: { type: "text" }): Promise<string | null> {
    if (_kvThrows) throw new Error("kv unavailable");
    return _kvData.get(key) ?? null;
  },
  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    if (_kvThrows) throw new Error("kv unavailable");
    _putCalls.push({ key, value, options });
    _kvData.set(key, value);
  },
};

let _envHasKv = true;
let _ctxThrows = false;

/**
 * Mock `@opennextjs/cloudflare` before the SUT imports it. Pattern lifted
 * from `tests/email/sender-workers.test.ts:37-48`. The module mock is
 * process-global and unrestoreable, so `afterAll` parks `_ctxThrows = true`
 * to match the out-of-Workers throw for any later test file importing the
 * indirection.
 */
mock.module("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (_opts?: { async?: boolean }) => {
    if (_ctxThrows) throw new Error("no request context");
    return {
      env: _envHasKv ? { AUTH_KV: fakeKv } : {},
      ctx: { waitUntil: () => {} },
    };
  },
}));

const { getPlatformBudgetStore, __resetMissingBindingWarnedForTest } =
  await import("@/lib/email/_budget.workers");

beforeEach(() => {
  _kvData.clear();
  _putCalls.length = 0;
  _kvThrows = false;
  _envHasKv = true;
  _ctxThrows = false;
  __resetMissingBindingWarnedForTest();
});

afterAll(() => {
  _ctxThrows = true;
});

test("committing writes the successor of the count that was read", async () => {
  const store = getPlatformBudgetStore()!;
  for (let i = 0; i < 3; i++) {
    const used = await store.read("k");
    await store.commit("k", used, 3600);
  }
  expect(await store.read("k")).toBe(3);
  expect(_putCalls.map((c) => c.value)).toEqual(["1", "2", "3"]);
});

test("a read without a commit leaves the stored count alone", async () => {
  // The property that stops a failed provider send from spending a
  // recipient's allowance.
  const store = getPlatformBudgetStore()!;
  expect(await store.read("untouched")).toBe(0);
  expect(await store.read("untouched")).toBe(0);
  expect(_putCalls).toHaveLength(0);
});

test("windowSeconds below KV's minimum is clamped to the 60s TTL floor", async () => {
  const store = getPlatformBudgetStore()!;
  await store.commit("short", 0, 30);
  await store.commit("long", 0, 3600);
  expect(_putCalls[0]?.options?.expirationTtl).toBe(60);
  expect(_putCalls[1]?.options?.expirationTtl).toBe(3600);
});

test("a garbage stored counter reads as zero instead of blocking sends", async () => {
  _kvData.set("junk", "not-a-number");
  const store = getPlatformBudgetStore()!;
  expect(await store.read("junk")).toBe(0);
});

test("a KV read outage reports no usage and logs the structured event", async () => {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    _kvThrows = true;
    const store = getPlatformBudgetStore()!;
    expect(await store.read("k")).toBe(0);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("email_budget_kv_op_failed");
  } finally {
    warnSpy.mockRestore();
  }
});

test("a KV write outage is swallowed, so the mail still counts as sent", async () => {
  // Concurrent sends to one address across POPs also land here: KV allows one
  // write per second per key and rejects the rest.
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    _kvThrows = true;
    const store = getPlatformBudgetStore()!;
    await store.commit("k", 0, 3600);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("email_budget_kv_op_failed");
  } finally {
    warnSpy.mockRestore();
  }
});

test("missing AUTH_KV binding yields no store and warns once per isolate", async () => {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    _envHasKv = false;
    expect(getPlatformBudgetStore()).toBeNull();
    expect(getPlatformBudgetStore()).toBeNull();
    const events = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("email_budget_kv_unavailable"));
    expect(events.length).toBe(1);
  } finally {
    warnSpy.mockRestore();
  }
});

test("no request context yields no store, mirroring boot-time access", async () => {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    _ctxThrows = true;
    expect(getPlatformBudgetStore()).toBeNull();
  } finally {
    warnSpy.mockRestore();
  }
});
