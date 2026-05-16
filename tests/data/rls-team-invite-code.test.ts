import { afterEach, describe, expect, test } from "bun:test";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";
import { appUserConnect, seedUserOrgProject } from "@/tests/setup/seed";
import { expectQueryRejects } from "@/tests/setup/expect-query";
import {
  releaseInviteCodeSlot,
  reserveInviteCodeSlot,
} from "@/lib/data/team-invite-code";

/**
 * Direct-SQL RLS tests for `team_invite_code` admin-only writes.
 *
 * Pins the defense-in-depth contract: a regular org member must NOT be able
 * to INSERT/UPDATE/DELETE invite-code rows via raw SQL even if they bypass
 * the action-layer `isOrgAdmin` check (e.g. a new endpoint that forgets to
 * call it, or SQL injection landing inside the app_user session). Any
 * member is still allowed to SELECT rows scoped to their own org.
 *
 * Membership-role changes use the testcontainer superuser (`getConnectionString`)
 * because `service_role` only has SELECT/REFERENCES on `neon_auth."member"`
 * by design (mirrors the prod grants in `docs/neon-prod-provisioning.sql`).
 */

afterEach(async () => {
  await truncateAll();
});

describe("team_invite_code RLS — admin-only writes", () => {
  test("regular member CANNOT INSERT a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("ic-member");
    const seed = superuserPool();
    try {
      await seed`UPDATE neon_auth."member" SET "role" = 'member'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    await expectQueryRejects(
      c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        await tx`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'BADCODE1', 'member')`;
      }),
      /row-level security|violates row-level security/i,
    );
  });

  test("admin CAN INSERT a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("ic-admin");
    const seed = superuserPool();
    try {
      await seed`UPDATE neon_auth."member" SET "role" = 'admin'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const rows = await tx<{ id: string }[]>`
          INSERT INTO team_invite_code (organization_id, code, default_role)
          VALUES (${fx.organizationId}, 'GOODCODE1', 'member')
          RETURNING id`;
        expect(rows.length).toBe(1);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("reserve → release(succeeded=true) saga: slot is consumed, reservation cleared", async () => {
    // Pins the JS-side saga: the data-layer helpers, called in the order
    // the action layer calls them, leave the row in the expected
    // committed state. The action layer wraps releaseInviteCodeSlot in
    // a safe try/catch — this test exercises the underlying contract.
    const owner = await seedUserOrgProject("ic-saga-owner");
    const joiner = await seedUserOrgProject("ic-saga-joiner");

    const seed = superuserPool();
    try {
      await seed`
        INSERT INTO team_invite_code (organization_id, code, created_by, max_uses)
        VALUES (${owner.organizationId}, 'SAGA-OK', ${owner.userId}, 1)
      `;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const reserved = await reserveInviteCodeSlot(joiner.userId, "SAGA-OK");
    expect(reserved).not.toBeNull();
    expect(reserved?.orgId).toBe(owner.organizationId);

    // Mid-saga inspection: use_count incremented, reserved_by set to
    // the joiner. After release(true): use_count stays, reservation cleared.
    await releaseInviteCodeSlot(joiner.userId, reserved!.id, true);

    const verify = superuserPool();
    try {
      const [row] = await verify<
        Array<{ use_count: number; reserved_by: string | null; reserved_until: Date | null }>
      >`
        SELECT use_count, reserved_by, reserved_until
        FROM team_invite_code
        WHERE id = ${reserved!.id}
      `;
      expect(row.use_count).toBe(1);
      expect(row.reserved_by).toBeNull();
      expect(row.reserved_until).toBeNull();
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("reserve → release(succeeded=false) saga: slot is freed, use_count decremented", async () => {
    // The compensating branch — `addMember` threw, the action calls
    // safeReleaseSlot(false). The slot is freed for retry.
    const owner = await seedUserOrgProject("ic-saga-fail-owner");
    const joiner = await seedUserOrgProject("ic-saga-fail-joiner");

    const seed = superuserPool();
    try {
      await seed`
        INSERT INTO team_invite_code (organization_id, code, created_by, max_uses)
        VALUES (${owner.organizationId}, 'SAGA-FAIL', ${owner.userId}, 5)
      `;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const reserved = await reserveInviteCodeSlot(joiner.userId, "SAGA-FAIL");
    expect(reserved).not.toBeNull();
    await releaseInviteCodeSlot(joiner.userId, reserved!.id, false);

    const verify = superuserPool();
    try {
      const [row] = await verify<
        Array<{ use_count: number; reserved_by: string | null }>
      >`
        SELECT use_count, reserved_by FROM team_invite_code
        WHERE id = ${reserved!.id}
      `;
      expect(row.use_count).toBe(0);
      expect(row.reserved_by).toBeNull();
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("concurrent reserves of a max_uses=1 code: exactly one succeeds", async () => {
    // The single-atomic-UPDATE design pinned by the SDF body. Two
    // simultaneous reserves on a 1-use code must serialize via row-lock
    // semantics so the second observes use_count >= max_uses and returns
    // null.
    const owner = await seedUserOrgProject("ic-race-owner");
    const joinerA = await seedUserOrgProject("ic-race-a");
    const joinerB = await seedUserOrgProject("ic-race-b");

    const seed = superuserPool();
    try {
      await seed`
        INSERT INTO team_invite_code (organization_id, code, created_by, max_uses)
        VALUES (${owner.organizationId}, 'RACE-ONE', ${owner.userId}, 1)
      `;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const [a, b] = await Promise.all([
      reserveInviteCodeSlot(joinerA.userId, "RACE-ONE"),
      reserveInviteCodeSlot(joinerB.userId, "RACE-ONE"),
    ]);

    const successes = [a, b].filter((r) => r !== null);
    expect(successes.length).toBe(1);
  });

  test("any member CAN SELECT team_invite_code rows for their org", async () => {
    const fx = await seedUserOrgProject("ic-select");
    const seed = superuserPool();
    try {
      await seed`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'SELECTABLE1', 'member')`;
      await seed`UPDATE neon_auth."member" SET "role" = 'member'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const rows = await tx<{ code: string }[]>`
          SELECT code FROM team_invite_code WHERE organization_id = ${fx.organizationId}`;
        expect(rows.length).toBe(1);
        expect(rows[0].code).toBe("SELECTABLE1");
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });
});
