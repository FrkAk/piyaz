import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db/rls";
import { legalAcceptances } from "@/lib/db/schema";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { recordDpaAcceptanceAction } from "@/lib/actions/legal";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { nextHeadersMockModule } from "@/tests/setup/next-headers-mock";

/**
 * Owner-gate contract for `recordDpaAcceptanceAction`. The action gates on
 * `isOrgOwner(organizationId)`, which resolves through
 * `auth.api.hasPermission`; that call is spied so the test drives the
 * owner/non-owner branches deterministically. `requireSession` is driven via
 * the preload's `__setTestSession` container, and `next/headers` is mocked at
 * file top so the action's internal `headers()` resolves outside a request.
 */

mock.module("next/headers", nextHeadersMockModule);

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

type HasPermissionImpl = () => Promise<{ success: boolean }>;

let nextHasPermission: HasPermissionImpl = async () => ({ success: false });
let hasPermissionSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  hasPermissionSpy = spyOn(
    auth.api as unknown as { hasPermission: HasPermissionImpl },
    "hasPermission",
  ).mockImplementation(() => nextHasPermission());
});

afterAll(() => {
  hasPermissionSpy.mockRestore();
});

afterEach(async () => {
  nextHasPermission = async () => ({ success: false });
  setSession(null);
  await truncateAll();
});

describe("recordDpaAcceptanceAction", () => {
  test("a non-owner member cannot record a DPA acceptance", async () => {
    const org = await seedUserOrgProject("dpa-action-forbidden", {
      legalCurrent: false,
    });
    const su = superuserPool();
    const [member] = await su<{ id: string }[]>`
      INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES ('DPA Non-owner', 'dpa-nonowner@test.local', true, now())
      RETURNING id
    `;
    await su`
      INSERT INTO piyaz_auth."member"
        ("organizationId", "userId", "role", "createdAt")
      VALUES (${org.organizationId}, ${member.id}, 'member', now())
    `;
    setSession({ user: { id: member.id } });
    nextHasPermission = async () => ({ success: false });

    const result = await recordDpaAcceptanceAction({
      organizationId: org.organizationId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable: ok asserted above");
    expect(result.code).toBe("forbidden");

    const rows = await withUserContext(member.id, async (tx) =>
      tx.select().from(legalAcceptances),
    );
    expect(rows.length).toBe(0);
  });

  test("an owner records exactly one pinned-version DPA row", async () => {
    const org = await seedUserOrgProject("dpa-action-owner", {
      legalCurrent: false,
    });
    setSession({ user: { id: org.userId } });
    nextHasPermission = async () => ({ success: true });

    const result = await recordDpaAcceptanceAction({
      organizationId: org.organizationId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable: ok asserted above");
    expect(result.data.version).toBe(LEGAL_VERSIONS.dpa);

    const rows = await withUserContext(org.userId, async (tx) =>
      tx.select().from(legalAcceptances),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].documentType).toBe("dpa");
    expect(rows[0].documentVersion).toBe(LEGAL_VERSIONS.dpa);
    expect(rows[0].userId).toBe(org.userId);
    expect(rows[0].organizationId).toBe(org.organizationId);
    expect(rows[0].acceptedAt).toBeInstanceOf(Date);
  });
});
