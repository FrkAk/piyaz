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
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";

/**
 * End-to-end coverage of `joinTeamByCodeAction`. Spies on the BA
 * `auth.api.addMember` call so it is fully controllable (success /
 * `already member` throw); seeds an actual `team_invite_code` row via
 * the superuser pool and drives the action so the saga interacts with
 * the real RLS + SDF stack.
 *
 * Pins the H6 contract: when `addMember` throws
 * USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION, the release-saga
 * compensates by decrementing `use_count` and clearing the reservation
 * (slot is freed), and the action surfaces the typed
 * `{ ok: false, code: "already_member" }` failure.
 *
 * `next/headers` is mocked at file-top (process-wide but stable across
 * the suite); `auth.api.addMember` is spied via `spyOn` in `beforeAll`
 * and restored in `afterAll`, keeping the real `@/lib/auth` instance
 * available to other test files in the same `bun test` invocation.
 * `mock.module("@/lib/auth", ...)` is unrestoreable per Bun docs and
 * would block tests that need the real BA handler (e.g.
 * `tests/auth/cookie-attributes.test.ts`).
 */

type AddMemberImpl = (...args: unknown[]) => Promise<unknown>;
let nextAddMember: AddMemberImpl = async () => ({});
let addMemberSpy: ReturnType<typeof spyOn>;

mock.module("next/headers", nextHeadersMockModule);

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

beforeAll(() => {
  addMemberSpy = spyOn(
    auth.api as unknown as { addMember: AddMemberImpl },
    "addMember",
  ).mockImplementation((...args: unknown[]) => nextAddMember(...args));
});

afterAll(() => {
  addMemberSpy.mockRestore();
});

beforeEach(() => {
  nextAddMember = async () => ({});
});

afterEach(async () => {
  nextAddMember = async () => ({});
  setSession(null);
  await truncateAll();
});

async function seedCode(
  orgId: string,
  code: string,
  opts: { maxUses?: number | null } = {},
): Promise<{ id: string }> {
  const su = superuserPool();
  const [row] = await su<{ id: string }[]>`
    INSERT INTO team_invite_code (organization_id, code, default_role, max_uses)
    VALUES (${orgId}, ${code}, 'member', ${opts.maxUses ?? null})
    RETURNING id
  `;
  return row;
}

async function readRow(id: string): Promise<{
  use_count: number;
  reserved_by: string | null;
  reserved_until: Date | null;
}> {
  const su = superuserPool();
  const [row] = await su<
    Array<{
      use_count: number;
      reserved_by: string | null;
      reserved_until: Date | null;
    }>
  >`
    SELECT use_count, reserved_by, reserved_until
    FROM team_invite_code WHERE id = ${id}
  `;
  return row;
}

describe("joinTeamByCodeAction — saga compensation paths (H6)", () => {
  test("joining when caller is already a member of the org refunds use_count and surfaces already_member", async () => {
    const owner = await seedUserOrgProject("h6-already-owner");
    const seeded = await seedCode(
      owner.organizationId,
      "h6alreadymemberxxxxxx",
      {
        maxUses: 1,
      },
    );
    setSession({ user: { id: owner.userId } });

    nextAddMember = async () => {
      throw {
        body: { code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" },
      };
    };

    const { joinTeamByCodeAction } = await import(
      "@/lib/actions/team-invite-code"
    );
    const result = await joinTeamByCodeAction({
      code: "h6alreadymemberxxxxxx",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("already_member");
    }

    const row = await readRow(seeded.id);
    expect(row.use_count).toBe(0);
    expect(row.reserved_by).toBeNull();
    expect(row.reserved_until).toBeNull();
  });

  test("joining a fresh code by a non-member succeeds and the slot is consumed", async () => {
    const owner = await seedUserOrgProject("h6-fresh-owner");
    const joiner = await seedUserOrgProject("h6-fresh-joiner");
    const seeded = await seedCode(
      owner.organizationId,
      "h6freshnonmemberxxxxx",
      {
        maxUses: 1,
      },
    );
    setSession({ user: { id: joiner.userId } });

    nextAddMember = async () => ({ id: "stub-member-id" });

    const { joinTeamByCodeAction } = await import(
      "@/lib/actions/team-invite-code"
    );
    const result = await joinTeamByCodeAction({
      code: "h6freshnonmemberxxxxx",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.organizationId).toBe(owner.organizationId);
    }

    const row = await readRow(seeded.id);
    expect(row.use_count).toBe(1);
    expect(row.reserved_by).toBeNull();
    expect(row.reserved_until).toBeNull();
  });

  test("joining an invalid code returns invalid_code and does not change DB state", async () => {
    const owner = await seedUserOrgProject("h6-invalid-owner");
    const seeded = await seedCode(
      owner.organizationId,
      "h6invalidcodeseeded01",
      {
        maxUses: 1,
      },
    );
    setSession({ user: { id: owner.userId } });

    nextAddMember = async () => {
      throw new Error("addMember must not be called on invalid_code");
    };

    const { joinTeamByCodeAction } = await import(
      "@/lib/actions/team-invite-code"
    );
    const result = await joinTeamByCodeAction({
      code: "h6notseededcodeunused",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_code");
    }

    const row = await readRow(seeded.id);
    expect(row.use_count).toBe(0);
    expect(row.reserved_by).toBeNull();
    expect(row.reserved_until).toBeNull();
  });
});
