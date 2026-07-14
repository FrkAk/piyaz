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
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";

/**
 * Action-level coverage for `deleteAccountAction`'s sole-owner pre-check.
 * On email-capable deploys Better Auth sends the confirmation email and
 * returns before `beforeDelete` runs, so the sole-owner block would only
 * surface at the emailed callback as a raw error. The action pre-checks
 * inline when `isEmailConfiguredAtBoot()` (driven here via `EMAIL_TRANSPORT`)
 * so the guidance stays inline and no doomed confirmation email is sent; on
 * email-disabled deploys the pre-check is skipped and Better Auth's
 * `beforeDelete` owns the block (covered by delete-account-cascade).
 *
 * `auth.api.deleteUser` is spied so the pre-check is exercised without the
 * BA delete path; asserting it is NOT called proves the block happens before
 * dispatch. The `_sender` indirection is pinned to the inert node defaults so
 * `isEmailConfiguredAtBoot()` follows `EMAIL_TRANSPORT` alone. Session comes
 * from the preload's `@/lib/auth/session` mock.
 */

mock.module("next/headers", nextHeadersMockModule);

mock.module("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

mock.module("@/lib/email/_sender", () => ({
  getPlatformSender: () => null,
  platformEmailConfigured: () => false,
}));

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

type ApiImpl = (...args: unknown[]) => Promise<unknown>;
let deleteUserSpy: ReturnType<typeof spyOn>;

const ORIGINAL_EMAIL_TRANSPORT = process.env.EMAIL_TRANSPORT;

/**
 * Add a member row to an org so the caller becomes a sole owner of a team
 * that still has other members (the `planOwnedOrgDeletion` block case).
 *
 * @param organizationId - Target org.
 * @param suffix - Unique suffix for the co-member's email.
 */
async function addCoMember(
  organizationId: string,
  suffix: string,
): Promise<void> {
  const sql = superuserPool();
  const [other] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES ('Co Member', ${"delacc-co-" + suffix + "@test.local"}, true, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${organizationId}, ${other.id}, 'member', now())
  `;
}

beforeAll(() => {
  deleteUserSpy = spyOn(
    auth.api as unknown as { deleteUser: ApiImpl },
    "deleteUser",
  ).mockImplementation(async () => ({ message: "Verification email sent" }));
});

afterAll(async () => {
  deleteUserSpy.mockRestore();
  if (ORIGINAL_EMAIL_TRANSPORT === undefined)
    delete process.env.EMAIL_TRANSPORT;
  else process.env.EMAIL_TRANSPORT = ORIGINAL_EMAIL_TRANSPORT;
  await truncateAll();
});

beforeEach(() => {
  setBackend("actions", new MemoryRateLimitBackend(60_000));
  deleteUserSpy.mockClear();
});

afterEach(async () => {
  setSession(null);
  delete process.env.EMAIL_TRANSPORT;
  await truncateAll();
});

describe("deleteAccountAction sole-owner pre-check", () => {
  test("email-capable: blocks a sole owner of a multi-member team before dispatch", async () => {
    process.env.EMAIL_TRANSPORT = "log";
    const fixture = await seedUserOrgProject("DELACC1");
    await addCoMember(fixture.organizationId, "1");
    setSession({ user: { id: fixture.userId } });

    const { deleteAccountAction } = await import("@/lib/actions/profile");
    const result = await deleteAccountAction();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("cannot_delete_sole_owner");
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  test("email-capable: dispatches when no team blocks and reports the emailed flow", async () => {
    process.env.EMAIL_TRANSPORT = "log";
    const fixture = await seedUserOrgProject("DELACC2");
    setSession({ user: { id: fixture.userId } });

    const { deleteAccountAction } = await import("@/lib/actions/profile");
    const result = await deleteAccountAction();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.verificationEmailSent).toBe(true);
    expect(deleteUserSpy).toHaveBeenCalledTimes(1);
  });

  test("email-disabled: skips the pre-check and forwards to Better Auth", async () => {
    delete process.env.EMAIL_TRANSPORT;
    const fixture = await seedUserOrgProject("DELACC3");
    await addCoMember(fixture.organizationId, "3");
    setSession({ user: { id: fixture.userId } });
    deleteUserSpy.mockImplementationOnce(async () => ({
      message: "User deleted",
    }));

    const { deleteAccountAction } = await import("@/lib/actions/profile");
    const result = await deleteAccountAction();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.verificationEmailSent).toBe(false);
    expect(deleteUserSpy).toHaveBeenCalledTimes(1);
  });
});
