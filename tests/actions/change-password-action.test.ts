import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { auth } from "@/lib/auth";
import { setBackend } from "@/lib/api/rate-limit";
import { MemoryRateLimitBackend } from "@/lib/api/rate-limit-memory";
import { checkActionUserRateLimit } from "@/lib/actions/rate-limit-action";

/**
 * Action-level coverage for `changePasswordAction`. The brute-force defense
 * for this flow lives entirely in the action, counted against the `"auth"`
 * backend slot (per-PoP CF binding on Workers, per-process memory on
 * self-host). The HTTP `/change-password` route is default-denied by the
 * auth catch-all allowlist, so no middleware rule or BA customRule covers
 * it — this file is the rate-limit and input-bound pin.
 *
 * `auth.api.changePassword` is spied (not the real handler) so routing and
 * input checks are exercised without a credential row or DB password write;
 * `next/headers` is mocked process-wide (headers + the cookies() stub BA's
 * `nextCookies` guard recognizes). `tests/setup/preload.ts` mocks
 * `@/lib/auth/session`, exposing `__setTestSession` to drive `getSession`.
 */

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => {
    throw new Error(
      "`cookies` was called outside a request scope. (test mock)",
    );
  },
}));

// revalidatePath needs a Next request/render scope and throws an invariant
// outside one. No test asserts on revalidation, so a no-op is faithful.
mock.module("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

const USER_ID = "11111111-1111-4111-8111-111111111111";

const RATE_CONFIG = {
  action: "password.change",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 10,
  backendKind: "auth" as const,
};

type ChangePasswordImpl = (...args: unknown[]) => Promise<unknown>;
let changePasswordSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  changePasswordSpy = spyOn(
    auth.api as unknown as { changePassword: ChangePasswordImpl },
    "changePassword",
  ).mockImplementation(async () => ({}));
});

afterAll(() => {
  changePasswordSpy.mockRestore();
});

beforeEach(() => {
  // Fresh per-slot memory backends so one test's counts never leak.
  setBackend("auth", new MemoryRateLimitBackend(60_000));
  setBackend("actions", new MemoryRateLimitBackend(60_000));
  setSession({ user: { id: USER_ID } });
  changePasswordSpy.mockClear();
});

afterEach(() => {
  setSession(null);
});

describe("changePasswordAction rate limiting", () => {
  test("counts against the auth backend (exhausting it blocks the action)", async () => {
    const { changePasswordAction } = await import("@/lib/actions/password");

    // Exhaust the per-user auth bucket through the SAME helper the action
    // uses, so the key format is never hardcoded.
    for (let i = 0; i < RATE_CONFIG.perUserMax; i++) {
      const outcome = await checkActionUserRateLimit(RATE_CONFIG, USER_ID);
      expect(outcome.ok).toBe(true);
    }

    const result = await changePasswordAction({
      currentPassword: "irrelevant-current",
      newPassword: "irrelevant-new-12",
    });
    expect(result).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Too many attempts. Please wait a moment and try again.",
    });
    expect(changePasswordSpy).not.toHaveBeenCalled();
  });

  test("ignores the unused actions backend (draining it does not block)", async () => {
    // Drain the default "actions" slot. Because the action opts into
    // "auth", this must NOT rate-limit it — proving the routing.
    const drainConfig = { ...RATE_CONFIG, backendKind: "actions" as const };
    for (let i = 0; i < drainConfig.perUserMax; i++) {
      await checkActionUserRateLimit(drainConfig, USER_ID);
    }

    const { changePasswordAction } = await import("@/lib/actions/password");
    const result = await changePasswordAction({
      currentPassword: "current-password-1",
      newPassword: "valid-new-pass-12",
    });
    expect(result.ok).toBe(true);
    expect(changePasswordSpy).toHaveBeenCalledTimes(1);
  });

  test("forwards revokeOtherSessions to Better Auth", async () => {
    const { changePasswordAction } = await import("@/lib/actions/password");
    await changePasswordAction({
      currentPassword: "current-password-1",
      newPassword: "valid-new-pass-12",
    });
    const call = changePasswordSpy.mock.calls[0]?.[0] as {
      body: { revokeOtherSessions?: boolean };
    };
    expect(call.body.revokeOtherSessions).toBe(true);
  });
});

describe("changePasswordAction input validation", () => {
  test("rejects an over-long current password before hashing", async () => {
    const { changePasswordAction } = await import("@/lib/actions/password");
    const result = await changePasswordAction({
      currentPassword: "x".repeat(200),
      newPassword: "valid-new-pass-12",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(changePasswordSpy).not.toHaveBeenCalled();
  });

  test("rejects a too-short new password", async () => {
    const { changePasswordAction } = await import("@/lib/actions/password");
    const result = await changePasswordAction({
      currentPassword: "current-password-1",
      newPassword: "short",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  test("returns unauthorized when no session is set", async () => {
    setSession(null);
    const { changePasswordAction } = await import("@/lib/actions/password");
    const result = await changePasswordAction({
      currentPassword: "current-password-1",
      newPassword: "valid-new-pass-12",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
    expect(changePasswordSpy).not.toHaveBeenCalled();
  });
});
