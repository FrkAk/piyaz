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

test("change-password has no middleware rule — it is not an HTTP-exposed path", () => {
  // The /change-password HTTP route is default-denied by the auth
  // catch-all allowlist (app/api/auth/[...all]/route.ts), and the feature
  // ships as a server action calling auth.api.changePassword directly. A
  // middleware rule here would only throttle requests that 404 anyway;
  // brute-force throttling lives in the action via the auth binding
  // (tests/actions/change-password-action.test.ts). Pin the absence so a
  // future edit does not resurrect a misleading dead rule.
  expect(matchRule("/api/auth/change-password")?.bindingKey ?? "api").toBe(
    "api",
  );
});

test("trailing slashes cannot dodge an exact-pattern rule", () => {
  // The auth route handler strips trailing slashes before dispatch, so the
  // limiter must normalize the same way or `/register/` escapes the strict
  // 5/60 ip rule onto the forgeable session-keyed catch-all.
  expect(matchRule("/api/auth/oauth2/register/")?.pattern).toBe(
    "/api/auth/oauth2/register",
  );
  expect(matchRule("/api/auth/oauth2/register///")?.keyStrategy).toBe("ip");
  expect(matchRule("/api/events/")).toBeNull();
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
