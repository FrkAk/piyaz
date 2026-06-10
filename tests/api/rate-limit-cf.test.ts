import { test, expect, beforeEach } from "bun:test";
import { getBackend, setBackend, matchRule } from "@/lib/api/rate-limit";
import { MemoryRateLimitBackend } from "@/lib/api/rate-limit-memory";
import {
  CloudflareRateLimitBackend,
  type CloudflareRateLimitBinding,
} from "@/lib/api/rate-limit-cf";

/**
 * Build a stub binding whose `limit` always resolves with the given success
 * flag — no I/O, no real CF runtime.
 *
 * @param success - The value to return from `limit`.
 * @returns Stub binding suitable for `CloudflareRateLimitBackend`.
 */
function fakeBinding(success: boolean): CloudflareRateLimitBinding {
  return { limit: async () => ({ success }) };
}

/**
 * Build a binding whose `limit` rejects, modeling a CF infrastructure
 * overload or transient RPC error.
 *
 * @returns Stub binding whose `limit` always throws.
 */
function brokenBinding(): CloudflareRateLimitBinding {
  return {
    limit: async () => {
      throw new Error("simulated binding outage");
    },
  };
}

/**
 * Reset every backend slot to a fresh `MemoryRateLimitBackend` so each test
 * starts from the same module-global state. Without this, a `setBackend`
 * call in one test leaks into the next.
 */
beforeEach(() => {
  setBackend("api", new MemoryRateLimitBackend(60_000));
  setBackend("auth", new MemoryRateLimitBackend(60_000));
  setBackend("actions", new MemoryRateLimitBackend(60_000));
});

test("getBackend() defaults to the api kind and returns the memory backend", () => {
  const backend = getBackend();
  expect(backend).toBe(getBackend("api"));
  expect(backend).toBeInstanceOf(MemoryRateLimitBackend);
});

test("api, auth, and actions backend slots stay independent after setBackend", () => {
  const apiBackend = new CloudflareRateLimitBackend(fakeBinding(true));
  const authBackend = new CloudflareRateLimitBackend(fakeBinding(false));
  setBackend("api", apiBackend);
  setBackend("auth", authBackend);
  expect(getBackend("api")).toBe(apiBackend);
  expect(getBackend("auth")).toBe(authBackend);
  expect(getBackend("api")).not.toBe(getBackend("auth"));
  expect(getBackend("actions")).not.toBe(getBackend("api"));
  expect(getBackend("actions")).toBeInstanceOf(MemoryRateLimitBackend);
});

test("auth rules precede the catch-all api rule in RATE_LIMIT_RULES", () => {
  expect(matchRule("/api/auth/sign-in/email")?.bindingKey).toBe("auth");
  expect(matchRule("/api/auth/sign-in/social")?.bindingKey).toBe("auth");
  expect(matchRule("/api/auth/sign-up/email")?.bindingKey).toBe("auth");
  expect(matchRule("/api/project/some-uuid")?.bindingKey ?? "api").toBe("api");
  expect(matchRule("/api/auth/get-session")?.bindingKey ?? "api").toBe("api");
});

test("open DCR registration is throttled by the strict auth binding", () => {
  const rule = matchRule("/api/auth/oauth2/register");
  expect(rule?.bindingKey).toBe("auth");
  expect(rule?.max).toBe(5);
  // Must not fall through to the loose /api/* catch-all.
  expect(rule?.pattern).toBe("/api/auth/oauth2/register");
  // Must key on IP, not the unvalidated session cookie: the register endpoint
  // is unauthenticated, so a `"session"` key lets a caller rotate a forged
  // cookie to mint a fresh bucket per request and bypass the limit.
  expect(rule?.keyStrategy).toBe("ip");
});

test("pre-auth endpoints key on IP, not the forgeable session cookie", () => {
  expect(matchRule("/api/auth/sign-in/email")?.keyStrategy).toBe("ip");
  expect(matchRule("/api/auth/sign-up/email")?.keyStrategy).toBe("ip");
});

test("CloudflareRateLimitBackend fails open by default on binding RPC error", async () => {
  const backend = new CloudflareRateLimitBackend(brokenBinding());
  const result = await backend.check("test-key", 100, 60);
  expect(result.allowed).toBe(true);
  expect(result.limit).toBe(100);
  expect(result.remaining).toBe(100);
  expect(result.resetIn).toBe(60);
});

test("CloudflareRateLimitBackend fails closed on binding RPC error when failOpen=false", async () => {
  const backend = new CloudflareRateLimitBackend(brokenBinding(), {
    failOpen: false,
  });
  const result = await backend.check("test-key", 5, 60);
  expect(result.allowed).toBe(false);
  expect(result.limit).toBe(5);
  expect(result.remaining).toBe(0);
  expect(result.resetIn).toBe(60);
});
