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
import {
  checkActionIpRateLimit,
  checkActionUserRateLimit,
} from "@/lib/actions/rate-limit-action";
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";

/**
 * Action-level coverage for `changePasswordAction`. The brute-force defense
 * for this flow lives entirely in the action, counted against the `"auth"`
 * backend slot (per-PoP CF binding on Workers, per-process memory on
 * self-host). The HTTP `/change-password` route is default-denied by the
 * auth catch-all allowlist, so no middleware rule or BA customRule covers
 * it — this file is the rate-limit and input-bound pin.
 *
 * `auth.api.changePassword` is spied (not the real handler) so routing and
 * input checks are exercised without a credential row or DB password write.
 * The session user is a seeded row (not synthetic) because the action's
 * consent gate reads `legal_acceptances` for real;
 * `next/headers` is mocked process-wide (headers + the cookies() stub BA's
 * `nextCookies` guard recognizes — see `tests/setup/next-headers-mock.ts`).
 * `tests/setup/preload.ts` mocks `@/lib/auth/session`, exposing
 * `__setTestSession` to drive `getSession`.
 */

mock.module("next/headers", nextHeadersMockModule);

// revalidatePath needs a Next request/render scope and throws an invariant
// outside one. No test asserts on revalidation, so a no-op is faithful.
mock.module("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

const setSession = (
  globalThis as unknown as {
    __setTestSession: (
      s: { user: { id: string; email?: string; name?: string } } | null,
    ) => void;
  }
).__setTestSession;

let USER_ID: string;

const RATE_CONFIG = {
  action: "password.change",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 5,
  backendKind: "auth" as const,
};

type ChangePasswordImpl = (...args: unknown[]) => Promise<unknown>;
let changePasswordSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  const fixture = await seedUserOrgProject("PWCHG");
  USER_ID = fixture.userId;
  changePasswordSpy = spyOn(
    auth.api as unknown as { changePassword: ChangePasswordImpl },
    "changePassword",
  ).mockImplementation(async () => ({}));
});

afterAll(async () => {
  changePasswordSpy.mockRestore();
  await truncateAll();
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

  test("exhausting the per-IP limb blocks the action before the session lookup", async () => {
    // Mirror of the per-user drain above for the IP limb (the mocked
    // empty Headers resolve every caller to the shared "unknown" IP key).
    // Together the two drains pin BOTH of the action's declared maxima to
    // RATE_CONFIG: a drift in either limb leaves its bucket under-drained
    // and the expected rate_limited rejection never fires.
    const { changePasswordAction } = await import("@/lib/actions/password");
    for (let i = 0; i < RATE_CONFIG.perIpMax; i++) {
      const outcome = await checkActionIpRateLimit(RATE_CONFIG);
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

  test("declared limits equal the RATE_LIMIT_AUTH binding's simple limit", async () => {
    // The CF binding enforces its own simple.limit per key regardless of
    // the max declared in code: a larger declared value would be silently
    // rewritten to the binding limit on Workers while self-host enforced
    // the declared number. The drain tests above pin RATE_CONFIG to the
    // action's real values, so asserting RATE_CONFIG against
    // wrangler.jsonc transitively pins the action to the binding.
    const wrangler = (await Bun.file(
      `${import.meta.dir}/../../wrangler.jsonc`,
    ).json()) as {
      env: {
        production: {
          ratelimits: {
            name: string;
            simple: { limit: number; period: number };
          }[];
        };
      };
    };
    const binding = wrangler.env.production.ratelimits.find(
      (b) => b.name === "RATE_LIMIT_AUTH",
    );
    expect(binding).toBeDefined();
    expect(RATE_CONFIG.perUserMax).toBe(binding!.simple.limit);
    expect(RATE_CONFIG.perIpMax).toBe(binding!.simple.limit);
    expect(RATE_CONFIG.windowSeconds).toBe(binding!.simple.period);
  });
});

describe("changePasswordAction notification", () => {
  test("sends the password-changed notification on success", async () => {
    process.env.EMAIL_TRANSPORT = "log";
    setSession({
      user: {
        id: USER_ID,
        email: "pwchg-notify@test.local",
        name: "Notify Me",
      },
    });
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const { changePasswordAction } = await import("@/lib/actions/password");
      const result = await changePasswordAction({
        currentPassword: "current-password-1",
        newPassword: "valid-new-pass-12",
      });
      expect(result.ok).toBe(true);
      const logged = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("[email:log]");
      expect(logged).toContain("password was changed");
      expect(logged).toContain("pwchg-notify@test.local");
    } finally {
      info.mockRestore();
      delete process.env.EMAIL_TRANSPORT;
    }
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

  test("rejects a new password identical to the current one", async () => {
    // A same-value change still fires revokeOtherSessions + the agent
    // revocation hook — a disruptive no-op. The action refuses it before
    // reaching Better Auth.
    const { changePasswordAction } = await import("@/lib/actions/password");
    const result = await changePasswordAction({
      currentPassword: "same-password-123",
      newPassword: "same-password-123",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(changePasswordSpy).not.toHaveBeenCalled();
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
