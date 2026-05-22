import { test, expect } from "bun:test";
import { getBackend, setBackend, matchRule } from "@/lib/api/rate-limit";
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

test("getBackend() defaults to the api kind", () => {
  expect(getBackend()).toBe(getBackend("api"));
});

test("api and auth backend slots stay independent after setBackend", () => {
  const apiBackend = new CloudflareRateLimitBackend(fakeBinding(true));
  const authBackend = new CloudflareRateLimitBackend(fakeBinding(false));
  setBackend("api", apiBackend);
  setBackend("auth", authBackend);
  expect(getBackend("api")).toBe(apiBackend);
  expect(getBackend("auth")).toBe(authBackend);
  expect(getBackend("api")).not.toBe(getBackend("auth"));
});

test("auth rules precede the catch-all api rule in RATE_LIMIT_RULES", () => {
  expect(matchRule("/api/auth/sign-in/email")?.bindingKey).toBe("auth");
  expect(matchRule("/api/auth/sign-in/social")?.bindingKey).toBe("auth");
  expect(matchRule("/api/auth/sign-up/email")?.bindingKey).toBe("auth");
  expect(matchRule("/api/project/some-uuid")?.bindingKey ?? "api").toBe("api");
  expect(matchRule("/api/auth/get-session")?.bindingKey ?? "api").toBe("api");
});

test("CloudflareRateLimitBackend fails open on binding RPC error", async () => {
  const backend = new CloudflareRateLimitBackend(brokenBinding());
  const result = await backend.check("test-key", 100, 60);
  expect(result.allowed).toBe(true);
  expect(result.limit).toBe(100);
  expect(result.remaining).toBe(100);
  expect(result.resetIn).toBe(60);
});
