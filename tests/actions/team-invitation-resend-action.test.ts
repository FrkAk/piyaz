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
 * Action-level coverage for `resendInvitationAction`'s guard order and
 * server-side row resolution: the invitation→org linkage predicate
 * (`isCallerInInvitationOrg`, real SDF against seeded rows) short-circuits
 * before any BA call, non-admins are rejected, non-pending and expired
 * rows map to `not_found`, and the happy path re-issues through
 * `createInvitation` with `resend: true` using the row's own email and
 * role — never client input.
 *
 * `auth.api.hasPermission` / `listInvitations` / `createInvitation` are
 * spied via `spyOn` (restored in `afterAll`); session comes from the
 * preload's `@/lib/auth/session` mock.
 */

mock.module("next/headers", nextHeadersMockModule);

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

type ApiImpl = (...args: unknown[]) => Promise<unknown>;

let hasPermissionSpy: ReturnType<typeof spyOn>;
let listInvitationsSpy: ReturnType<typeof spyOn>;
let createInvitationSpy: ReturnType<typeof spyOn>;
let nextHasPermission: ApiImpl = async () => ({ success: true });
let nextListInvitations: ApiImpl = async () => [];

beforeAll(() => {
  hasPermissionSpy = spyOn(
    auth.api as unknown as { hasPermission: ApiImpl },
    "hasPermission",
  ).mockImplementation((...args: unknown[]) => nextHasPermission(...args));
  listInvitationsSpy = spyOn(
    auth.api as unknown as { listInvitations: ApiImpl },
    "listInvitations",
  ).mockImplementation((...args: unknown[]) => nextListInvitations(...args));
  createInvitationSpy = spyOn(
    auth.api as unknown as { createInvitation: ApiImpl },
    "createInvitation",
  ).mockImplementation(async () => ({}));
});

afterAll(async () => {
  hasPermissionSpy.mockRestore();
  listInvitationsSpy.mockRestore();
  createInvitationSpy.mockRestore();
  await truncateAll();
});

beforeEach(() => {
  setBackend("actions", new MemoryRateLimitBackend(60_000));
  nextHasPermission = async () => ({ success: true });
  nextListInvitations = async () => [];
  hasPermissionSpy.mockClear();
  listInvitationsSpy.mockClear();
  createInvitationSpy.mockClear();
});

afterEach(async () => {
  setSession(null);
  await truncateAll();
});

/**
 * Seed a real invitation row so the SDF linkage predicate has something
 * to resolve.
 *
 * @param organizationId - Owning org.
 * @param inviterId - Existing user id recorded as the inviter.
 * @param email - Invited address.
 * @returns The new invitation's id.
 */
async function seedInvitation(
  organizationId: string,
  inviterId: string,
  email: string,
): Promise<string> {
  const sql = superuserPool();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."invitation"
      ("organizationId", "email", "role", "status", "expiresAt", "inviterId")
    VALUES
      (${organizationId}, ${email}, 'member', 'pending',
       now() + interval '48 hours', ${inviterId})
    RETURNING id
  `;
  return row.id;
}

describe("resendInvitationAction", () => {
  test("id/org mismatch surfaces not_found before any BA call", async () => {
    const callerFixture = await seedUserOrgProject("RSND1A");
    const otherFixture = await seedUserOrgProject("RSND1B");
    const invitationId = await seedInvitation(
      otherFixture.organizationId,
      otherFixture.userId,
      "rsnd1@test.local",
    );
    setSession({ user: { id: callerFixture.userId } });

    const { resendInvitationAction } = await import(
      "@/lib/actions/team-invitations"
    );
    const result = await resendInvitationAction({
      invitationId,
      organizationId: callerFixture.organizationId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
    expect(hasPermissionSpy).not.toHaveBeenCalled();
    expect(createInvitationSpy).not.toHaveBeenCalled();
  });

  test("non-admin caller is rejected with forbidden", async () => {
    const fixture = await seedUserOrgProject("RSND2");
    const invitationId = await seedInvitation(
      fixture.organizationId,
      fixture.userId,
      "rsnd2@test.local",
    );
    setSession({ user: { id: fixture.userId } });
    nextHasPermission = async () => ({ success: false });

    const { resendInvitationAction } = await import(
      "@/lib/actions/team-invitations"
    );
    const result = await resendInvitationAction({
      invitationId,
      organizationId: fixture.organizationId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("forbidden");
    expect(createInvitationSpy).not.toHaveBeenCalled();
  });

  test("a non-pending row maps to not_found without re-issuing", async () => {
    const fixture = await seedUserOrgProject("RSND3");
    const invitationId = await seedInvitation(
      fixture.organizationId,
      fixture.userId,
      "rsnd3@test.local",
    );
    setSession({ user: { id: fixture.userId } });
    nextListInvitations = async () => [
      {
        id: invitationId,
        organizationId: fixture.organizationId,
        email: "rsnd3@test.local",
        role: "member",
        status: "canceled",
        inviterId: fixture.userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ];

    const { resendInvitationAction } = await import(
      "@/lib/actions/team-invitations"
    );
    const result = await resendInvitationAction({
      invitationId,
      organizationId: fixture.organizationId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
    expect(createInvitationSpy).not.toHaveBeenCalled();
  });

  test("an expired pending row maps to not_found without re-issuing", async () => {
    const fixture = await seedUserOrgProject("RSND4");
    const invitationId = await seedInvitation(
      fixture.organizationId,
      fixture.userId,
      "rsnd4@test.local",
    );
    setSession({ user: { id: fixture.userId } });
    nextListInvitations = async () => [
      {
        id: invitationId,
        organizationId: fixture.organizationId,
        email: "rsnd4@test.local",
        role: "member",
        status: "pending",
        inviterId: fixture.userId,
        expiresAt: new Date(Date.now() - 1_000),
      },
    ];

    const { resendInvitationAction } = await import(
      "@/lib/actions/team-invitations"
    );
    const result = await resendInvitationAction({
      invitationId,
      organizationId: fixture.organizationId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
    expect(createInvitationSpy).not.toHaveBeenCalled();
  });

  test("happy path re-issues the row's own email and role with resend: true", async () => {
    const fixture = await seedUserOrgProject("RSND5");
    const invitationId = await seedInvitation(
      fixture.organizationId,
      fixture.userId,
      "rsnd5@test.local",
    );
    setSession({ user: { id: fixture.userId } });
    nextListInvitations = async () => [
      {
        id: invitationId,
        organizationId: fixture.organizationId,
        email: "rsnd5@test.local",
        role: "admin",
        status: "pending",
        inviterId: fixture.userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ];

    const { resendInvitationAction } = await import(
      "@/lib/actions/team-invitations"
    );
    const result = await resendInvitationAction({
      invitationId,
      organizationId: fixture.organizationId,
    });

    expect(result.ok).toBe(true);
    expect(createInvitationSpy).toHaveBeenCalledTimes(1);
    const call = createInvitationSpy.mock.calls[0]?.[0] as {
      body?: Record<string, unknown>;
    };
    expect(call.body).toEqual({
      email: "rsnd5@test.local",
      role: "admin",
      organizationId: fixture.organizationId,
      resend: true,
    });
  });
});
