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
 * Action-level coverage for `changeEmailAction`: rate limiting on the
 * `"auth"` backend slot, input bounds, the email-capability gate, the
 * current-password re-entry gate, and body forwarding. The HTTP
 * `/change-email` route is default-denied by the auth catch-all allowlist,
 * so this action is the flow's only initiation path and its rate limits are
 * the flow's only throttle.
 *
 * `auth.api.verifyPassword` and `auth.api.changeEmail` are spied so routing
 * and gating are exercised without scrypt work or a credential row. The
 * capability gate is driven via `EMAIL_TRANSPORT=log` (deterministic
 * regardless of whether another test file has mocked the platform sender
 * indirection). Session comes from the preload's `@/lib/auth/session` mock.
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
      s: { user: { id: string; email?: string } } | null,
    ) => void;
  }
).__setTestSession;

let USER_ID: string;
const SESSION_EMAIL = "emchg-current@test.local";

const RATE_CONFIG = {
  action: "email.change",
  windowSeconds: 60,
  perUserMax: 5,
  perIpMax: 5,
  backendKind: "auth" as const,
};

type ApiImpl = (...args: unknown[]) => Promise<unknown>;
let verifyPasswordSpy: ReturnType<typeof spyOn>;
let changeEmailSpy: ReturnType<typeof spyOn>;

const ORIGINAL_EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT;

beforeAll(async () => {
  const fixture = await seedUserOrgProject("EMCHG");
  USER_ID = fixture.userId;
  verifyPasswordSpy = spyOn(
    auth.api as unknown as { verifyPassword: ApiImpl },
    "verifyPassword",
  ).mockImplementation(async () => ({ status: true }));
  changeEmailSpy = spyOn(
    auth.api as unknown as { changeEmail: ApiImpl },
    "changeEmail",
  ).mockImplementation(async () => ({ status: true }));
});

afterAll(async () => {
  verifyPasswordSpy.mockRestore();
  changeEmailSpy.mockRestore();
  if (ORIGINAL_EMAIL_TRANSPORT === undefined)
    delete process.env.EMAIL_TRANSPORT;
  else process.env.EMAIL_TRANSPORT = ORIGINAL_EMAIL_TRANSPORT;
  await truncateAll();
});

beforeEach(() => {
  setBackend("auth", new MemoryRateLimitBackend(60_000));
  setBackend("actions", new MemoryRateLimitBackend(60_000));
  setSession({ user: { id: USER_ID, email: SESSION_EMAIL } });
  process.env.EMAIL_TRANSPORT = "log";
  verifyPasswordSpy.mockClear();
  changeEmailSpy.mockClear();
});

afterEach(() => {
  setSession(null);
  delete process.env.EMAIL_TRANSPORT;
});

const VALID_INPUT = {
  newEmail: "emchg-new@test.local",
  currentPassword: "current-password-1",
};

describe("changeEmailAction gating", () => {
  test("returns unauthorized when no session is set", async () => {
    setSession(null);
    const { changeEmailAction } = await import("@/lib/actions/profile");
    const result = await changeEmailAction(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
    expect(verifyPasswordSpy).not.toHaveBeenCalled();
  });

  test("returns email_not_configured when no transport is configured", async () => {
    delete process.env.EMAIL_TRANSPORT;
    const { changeEmailAction } = await import("@/lib/actions/profile");
    const result = await changeEmailAction(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("email_not_configured");
    expect(verifyPasswordSpy).not.toHaveBeenCalled();
    expect(changeEmailSpy).not.toHaveBeenCalled();
  });

  test("rejects the current address as the new email", async () => {
    const { changeEmailAction } = await import("@/lib/actions/profile");
    const result = await changeEmailAction({
      newEmail: SESSION_EMAIL.toUpperCase(),
      currentPassword: "current-password-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(verifyPasswordSpy).not.toHaveBeenCalled();
  });

  test("maps a failed password verify to invalid_password and never dispatches the change", async () => {
    verifyPasswordSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error("invalid password"), {
        body: { code: "INVALID_PASSWORD" },
      });
    });
    const { changeEmailAction } = await import("@/lib/actions/profile");
    const result = await changeEmailAction(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_password");
    expect(changeEmailSpy).not.toHaveBeenCalled();
  });

  test("verifies the password, then forwards the change with the settings callback", async () => {
    const { changeEmailAction } = await import("@/lib/actions/profile");
    const result = await changeEmailAction({
      newEmail: "  EMCHG-New@Test.Local ",
      currentPassword: "current-password-1",
    });
    expect(result.ok).toBe(true);
    expect(verifyPasswordSpy).toHaveBeenCalledTimes(1);
    const verifyCall = verifyPasswordSpy.mock.calls[0]?.[0] as {
      body: { password: string };
    };
    expect(verifyCall.body.password).toBe("current-password-1");
    expect(changeEmailSpy).toHaveBeenCalledTimes(1);
    const changeCall = changeEmailSpy.mock.calls[0]?.[0] as {
      body: { newEmail: string; callbackURL: string };
    };
    expect(changeCall.body.newEmail).toBe("emchg-new@test.local");
    expect(changeCall.body.callbackURL).toBe("/settings");
  });
});

describe("changeEmailAction rate limiting", () => {
  test("exhausting the per-user auth bucket blocks the action", async () => {
    const { changeEmailAction } = await import("@/lib/actions/profile");
    for (let i = 0; i < RATE_CONFIG.perUserMax; i++) {
      const outcome = await checkActionUserRateLimit(RATE_CONFIG, USER_ID);
      expect(outcome.ok).toBe(true);
    }
    const result = await changeEmailAction(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limited");
    expect(verifyPasswordSpy).not.toHaveBeenCalled();
  });

  test("exhausting the per-IP limb blocks the action before the session lookup", async () => {
    const { changeEmailAction } = await import("@/lib/actions/profile");
    for (let i = 0; i < RATE_CONFIG.perIpMax; i++) {
      const outcome = await checkActionIpRateLimit(RATE_CONFIG);
      expect(outcome.ok).toBe(true);
    }
    const result = await changeEmailAction(VALID_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limited");
    expect(verifyPasswordSpy).not.toHaveBeenCalled();
  });
});

describe("changeEmailAction input validation", () => {
  test("rejects a malformed email before any auth work", async () => {
    const { changeEmailAction } = await import("@/lib/actions/profile");
    const result = await changeEmailAction({
      newEmail: "not-an-email",
      currentPassword: "current-password-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(verifyPasswordSpy).not.toHaveBeenCalled();
  });

  test("rejects an over-long current password before hashing", async () => {
    const { changeEmailAction } = await import("@/lib/actions/profile");
    const result = await changeEmailAction({
      newEmail: "emchg-new@test.local",
      currentPassword: "x".repeat(200),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(verifyPasswordSpy).not.toHaveBeenCalled();
  });
});
