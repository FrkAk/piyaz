import { test, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";

/**
 * Cloudflare KV email budget store (`lib/email/_budget.workers.ts`): counting
 * against KV, the TTL floor, fail-open on KV errors, and the warn-once
 * missing-binding path. Mirrors `tests/email/sender-workers.test.ts`.
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
  async get(key: string, _type: "text"): Promise<string | null> {
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

test("consume counts up in KV and denies past max", async () => {
  const store = getPlatformBudgetStore()!;
  expect(await store.consume("k", 3, 3600)).toBe(true);
  expect(await store.consume("k", 3, 3600)).toBe(true);
  expect(await store.consume("k", 3, 3600)).toBe(true);
  expect(await store.consume("k", 3, 3600)).toBe(false);
  expect(_putCalls.map((c) => c.value)).toEqual(["1", "2", "3"]);
});

test("windowSeconds below KV's minimum is clamped to the 60s TTL floor", async () => {
  const store = getPlatformBudgetStore()!;
  await store.consume("short", 3, 30);
  await store.consume("long", 3, 3600);
  expect(_putCalls[0]?.options?.expirationTtl).toBe(60);
  expect(_putCalls[1]?.options?.expirationTtl).toBe(3600);
});

test("a garbage stored counter resets to zero instead of blocking sends", async () => {
  _kvData.set("junk", "not-a-number");
  const store = getPlatformBudgetStore()!;
  expect(await store.consume("junk", 3, 3600)).toBe(true);
  expect(_putCalls[0]?.value).toBe("1");
});

test("a KV outage fails open and logs the structured event", async () => {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    _kvThrows = true;
    const store = getPlatformBudgetStore()!;
    expect(await store.consume("k", 3, 3600)).toBe(true);
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
