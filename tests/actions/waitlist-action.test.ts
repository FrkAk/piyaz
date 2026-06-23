import { test, expect, describe, beforeEach, mock } from "bun:test";

/**
 * Coverage for the waitlist capture path: the `joinWaitlistAction` server
 * action and its `putWaitlistEntry` KV writer. Both live in one file
 * because bun's `mock.module` is process-global and unrestoreable — keeping
 * every mock of `@opennextjs/cloudflare` and `@/lib/actions/rate-limit-action`
 * in a single file avoids cross-file registry pollution.
 *
 * `@opennextjs/cloudflare` is faked so the REAL `putWaitlistEntry` runs
 * against an in-memory KV (pattern from
 * `tests/auth/kv-secondary-storage.workers.test.ts`); the rate limiter is
 * faked so the action's limit-before-parse ordering is observable without
 * a request context. No DB, no CF runtime.
 */

const _putCalls: Array<{ key: string; value: string }> = [];
let _throwOnPut = false;
let _envHasKv = true;

const fakeKv = {
  async put(key: string, value: string) {
    if (_throwOnPut) throw new Error("kv put boom");
    _putCalls.push({ key, value });
  },
};

mock.module("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (_opts?: { async?: boolean }) => ({
    env: _envHasKv ? { WAITLIST_KV: fakeKv } : {},
    ctx: { waitUntil: () => {} },
  }),
}));

type RateLimitOutcome = { ok: true } | { ok: false; retryAfter: number };
let _rateLimitOutcome: RateLimitOutcome = { ok: true };

// Spread the real module and override ONLY checkActionRateLimit. bun's
// mock.module is process-global and unrestoreable, so a whole-replace here
// would strip checkActionUserRateLimit / checkActionIpRateLimit from the
// module registry for every later test file (e.g. change-password-action.test.ts
// imports the real checkActionUserRateLimit). Preserving the real exports keeps
// those symbols resolvable across the full-suite run.
const _actualRateLimit = await import("@/lib/actions/rate-limit-action");

mock.module("@/lib/actions/rate-limit-action", () => ({
  ..._actualRateLimit,
  checkActionRateLimit: async () => _rateLimitOutcome,
}));

const { putWaitlistEntry, __resetMissingBindingWarnedForTest } = await import(
  "@/lib/db/_waitlist-kv.workers"
);
const { joinWaitlistAction } = await import("@/lib/actions/waitlist");

beforeEach(() => {
  _putCalls.length = 0;
  _throwOnPut = false;
  _envHasKv = true;
  _rateLimitOutcome = { ok: true };
  __resetMissingBindingWarnedForTest();
});

describe("putWaitlistEntry", () => {
  test("stored: writes email as key with JSON { ts, source } value", async () => {
    const result = await putWaitlistEntry("person@example.com");
    expect(result).toBe("stored");
    expect(_putCalls.length).toBe(1);
    expect(_putCalls[0].key).toBe("person@example.com");
    const parsed = JSON.parse(_putCalls[0].value) as {
      ts: number;
      source: string;
    };
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.source).toBe("signup-page");
  });

  test("missing WAITLIST_KV binding: returns unavailable, no write", async () => {
    _envHasKv = false;
    const result = await putWaitlistEntry("person@example.com");
    expect(result).toBe("unavailable");
    expect(_putCalls.length).toBe(0);
  });

  test("kv put throws: swallowed, still returns stored", async () => {
    _throwOnPut = true;
    const result = await putWaitlistEntry("person@example.com");
    expect(result).toBe("stored");
  });
});

describe("joinWaitlistAction", () => {
  test("valid email: ok, and the normalized email is written to KV", async () => {
    const result = await joinWaitlistAction({ email: "person@example.com" });
    expect(result.ok).toBe(true);
    expect(_putCalls.map((c) => c.key)).toEqual(["person@example.com"]);
  });

  test("uppercase + whitespace email is normalized before the KV write", async () => {
    const result = await joinWaitlistAction({
      email: "  PERSON@Example.COM  ",
    });
    expect(result.ok).toBe(true);
    expect(_putCalls.map((c) => c.key)).toEqual(["person@example.com"]);
  });

  test("invalid email: invalid_email, no KV write", async () => {
    const result = await joinWaitlistAction({ email: "not-an-email" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_email");
    expect(_putCalls.length).toBe(0);
  });

  test("rate-limited: rate_limited, limiter runs before any KV write", async () => {
    _rateLimitOutcome = { ok: false, retryAfter: 42 };
    const result = await joinWaitlistAction({ email: "person@example.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limited");
    expect(_putCalls.length).toBe(0);
  });

  test("duplicate submit is idempotent: both calls return ok (overwrite)", async () => {
    const first = await joinWaitlistAction({ email: "dupe@example.com" });
    const second = await joinWaitlistAction({ email: "dupe@example.com" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(_putCalls.map((c) => c.key)).toEqual([
      "dupe@example.com",
      "dupe@example.com",
    ]);
  });

  test("missing binding: 'unavailable' maps to unknown", async () => {
    _envHasKv = false;
    const result = await joinWaitlistAction({ email: "person@example.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown");
  });
});
