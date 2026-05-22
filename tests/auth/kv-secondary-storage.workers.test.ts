import { test, expect, beforeEach, mock } from "bun:test";

/**
 * Captured `expirationTtl` shape passed to the fake KV's `put`. Mirrors the
 * Cloudflare KV binding's `put` options surface.
 */
interface FakeOpts {
  expirationTtl?: number;
}

const _store = new Map<string, string>();
const _putCalls: Array<{ key: string; value: string; opts?: FakeOpts }> = [];

const fakeKv = {
  async get(key: string, _type: "text") {
    return _store.get(key) ?? null;
  },
  async put(key: string, value: string, opts?: FakeOpts) {
    _store.set(key, value);
    _putCalls.push({ key, value, opts });
  },
  async delete(key: string) {
    _store.delete(key);
  },
};

let _envHasKv = true;

/**
 * Mock `@opennextjs/cloudflare`'s `getCloudflareContext` before the SUT
 * imports it. Pattern lifted from `tests/realtime/broker-do.test.ts:17-26`.
 * `_envHasKv` flips per test to exercise the graceful-no-op path.
 */
mock.module("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: _envHasKv ? { AUTH_KV: fakeKv } : {},
    ctx: { waitUntil: () => {} },
  }),
}));

const { getKvSecondaryStorage } = await import(
  "@/lib/db/_auth-kv-storage.workers"
);

beforeEach(() => {
  _store.clear();
  _putCalls.length = 0;
  _envHasKv = true;
});

test("set clamps ttl < 60 to 60", async () => {
  await getKvSecondaryStorage().set("k", "v", 10);
  expect(_putCalls[0].opts?.expirationTtl).toBe(60);
});

test("set with ttl === 60 stays 60", async () => {
  await getKvSecondaryStorage().set("k", "v", 60);
  expect(_putCalls[0].opts?.expirationTtl).toBe(60);
});

test("set with ttl > 60 passes through", async () => {
  await getKvSecondaryStorage().set("k", "v", 3600);
  expect(_putCalls[0].opts?.expirationTtl).toBe(3600);
});

test("set with no ttl omits expirationTtl", async () => {
  await getKvSecondaryStorage().set("k", "v");
  expect(_putCalls[0].opts).toBeUndefined();
});

test("get returns null on miss, value on hit", async () => {
  const s = getKvSecondaryStorage();
  expect(await s.get("missing")).toBeNull();
  await s.set("k", "v");
  expect(await s.get("k")).toBe("v");
});

test("delete removes the key", async () => {
  const s = getKvSecondaryStorage();
  await s.set("k", "v");
  await s.delete("k");
  expect(await s.get("k")).toBeNull();
});

test("missing AUTH_KV: get returns null, set/delete no-op", async () => {
  _envHasKv = false;
  const s = getKvSecondaryStorage();
  expect(await s.get("k")).toBeNull();
  await s.set("k", "v");
  expect(_putCalls.length).toBe(0);
  await s.delete("k");
});
