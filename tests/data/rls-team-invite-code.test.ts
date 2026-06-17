import { afterEach, describe, expect, test } from "bun:test";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";
import { appUserConnect, seedUserOrgProject } from "@/tests/setup/seed";
import { expectQueryRejects } from "@/tests/setup/expect-query";
import { makeAuthContext } from "@/lib/auth/context";
import {
  releaseInviteCodeSlot,
  reserveInviteCodeSlot,
} from "@/lib/data/team-invite-code";

/**
 * Direct-SQL RLS tests for `team_invite_code` admin-only access.
 *
 * Pins the defense-in-depth contract: a regular org member must NOT be able
 * to SELECT/INSERT/UPDATE/DELETE invite-code rows via raw SQL even if they
 * bypass the action-layer `isOrgAdmin` check (e.g. a new endpoint that
 * forgets to call it, or SQL injection landing inside the app_user
 * session). The redemption SDFs are SECURITY DEFINER and sidestep the
 * policy so the join flow still works for non-admin members.
 *
 * Membership-role changes use the testcontainer superuser (`getConnectionString`)
 * because `service_role` only has SELECT/REFERENCES on `piyaz_auth."member"`
 * by design (see `docker/grants.sql`).
 */

afterEach(async () => {
  await truncateAll();
});

describe("team_invite_code RLS — admin-only writes", () => {
  test("regular member CANNOT INSERT a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("ic-member");
    const seed = superuserPool();
    try {
      await seed`UPDATE piyaz_auth."member" SET "role" = 'member'
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
      await seed`UPDATE piyaz_auth."member" SET "role" = 'admin'
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

    const reserved = await reserveInviteCodeSlot(
      makeAuthContext(joiner.userId),
      "SAGA-OK",
    );
    expect(reserved).not.toBeNull();
    expect(reserved?.orgId).toBe(owner.organizationId);

    await releaseInviteCodeSlot(joiner.userId, reserved!.id, true);

    const verify = superuserPool();
    try {
      const [row] = await verify<
        Array<{
          use_count: number;
          reserved_by: string | null;
          reserved_until: Date | null;
        }>
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

    const reserved = await reserveInviteCodeSlot(
      makeAuthContext(joiner.userId),
      "SAGA-FAIL",
    );
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
      reserveInviteCodeSlot(makeAuthContext(joinerA.userId), "RACE-ONE"),
      reserveInviteCodeSlot(makeAuthContext(joinerB.userId), "RACE-ONE"),
    ]);

    const successes = [a, b].filter((r) => r !== null);
    expect(successes.length).toBe(1);
  });

  test("RESTRICTIVE write floor holds even when a permissive INSERT policy is added", async () => {
    // The RESTRICTIVE `team_invite_code_insert_admin_only` AND's with
    // the OR of permissives; a stray `WITH CHECK (true)` cannot relax it.
    const fx = await seedUserOrgProject("tc3-member");
    const seed = superuserPool();
    try {
      await seed`UPDATE piyaz_auth."member" SET "role" = 'member'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
      await seed`CREATE POLICY temp_member_can_write ON team_invite_code
                 AS PERMISSIVE FOR INSERT TO app_user WITH CHECK (true)`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    try {
      const c = appUserConnect();
      await expectQueryRejects(
        c.begin(async (tx) => {
          await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
          await tx`INSERT INTO team_invite_code (organization_id, code, default_role)
                   VALUES (${fx.organizationId}, 'TC3-BLOCKED', 'member')`;
        }),
        /row-level security|violates row-level security/i,
      );
    } finally {
      const cleanup = superuserPool();
      try {
        await cleanup`DROP POLICY IF EXISTS temp_member_can_write ON team_invite_code`;
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    }
  });

  test("release(succeeded=false) replay is a no-op — use_count not decremented twice", async () => {
    // Pins the M1 idempotency guard: the SDF gates on
    // `reserved_until IS NOT NULL`, so once the first release clears the
    // reservation, the second matches zero rows. The JS wrapper logs but
    // does not throw.
    const owner = await seedUserOrgProject("ic-replay-fail-owner");
    const joiner = await seedUserOrgProject("ic-replay-fail-joiner");

    const seed = superuserPool();
    try {
      await seed`
        INSERT INTO team_invite_code (organization_id, code, created_by, max_uses)
        VALUES (${owner.organizationId}, 'REPLAY-FAIL', ${owner.userId}, 1)
      `;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const reserved = await reserveInviteCodeSlot(
      makeAuthContext(joiner.userId),
      "REPLAY-FAIL",
    );
    expect(reserved).not.toBeNull();
    await releaseInviteCodeSlot(joiner.userId, reserved!.id, false);

    const verify = superuserPool();
    try {
      const [afterFirst] = await verify<
        Array<{
          use_count: number;
          reserved_by: string | null;
          reserved_until: Date | null;
        }>
      >`SELECT use_count, reserved_by, reserved_until FROM team_invite_code
        WHERE id = ${reserved!.id}`;
      expect(afterFirst.use_count).toBe(0);
      expect(afterFirst.reserved_by).toBeNull();
      expect(afterFirst.reserved_until).toBeNull();

      await releaseInviteCodeSlot(joiner.userId, reserved!.id, false);

      const [afterReplay] = await verify<
        Array<{
          use_count: number;
          reserved_by: string | null;
          reserved_until: Date | null;
        }>
      >`SELECT use_count, reserved_by, reserved_until FROM team_invite_code
        WHERE id = ${reserved!.id}`;
      expect(afterReplay.use_count).toBe(0);
      expect(afterReplay.reserved_by).toBeNull();
      expect(afterReplay.reserved_until).toBeNull();
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("release(succeeded=true) then release(succeeded=false) replay does not refund use_count", async () => {
    // Sibling of the replay-fail case. If the first release committed the
    // slot (succeeded=true keeps use_count, clears reservation), a stray
    // second release(false) MUST NOT decrement use_count back — the slot
    // is consumed.
    const owner = await seedUserOrgProject("ic-replay-mix-owner");
    const joiner = await seedUserOrgProject("ic-replay-mix-joiner");

    const seed = superuserPool();
    try {
      await seed`
        INSERT INTO team_invite_code (organization_id, code, created_by, max_uses)
        VALUES (${owner.organizationId}, 'REPLAY-MIX', ${owner.userId}, 1)
      `;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const reserved = await reserveInviteCodeSlot(
      makeAuthContext(joiner.userId),
      "REPLAY-MIX",
    );
    expect(reserved).not.toBeNull();
    await releaseInviteCodeSlot(joiner.userId, reserved!.id, true);
    await releaseInviteCodeSlot(joiner.userId, reserved!.id, false);

    const verify = superuserPool();
    try {
      const [row] = await verify<
        Array<{
          use_count: number;
          reserved_by: string | null;
          reserved_until: Date | null;
        }>
      >`SELECT use_count, reserved_by, reserved_until FROM team_invite_code
        WHERE id = ${reserved!.id}`;
      expect(row.use_count).toBe(1);
      expect(row.reserved_by).toBeNull();
      expect(row.reserved_until).toBeNull();
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("regular member CANNOT SELECT team_invite_code rows via direct SQL", async () => {
    const fx = await seedUserOrgProject("h1-sel-member");
    const seed = superuserPool();
    try {
      await seed`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'h1selmember', 'member')`;
      await seed`UPDATE piyaz_auth."member" SET "role" = 'member'
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
        expect(rows.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("admin CAN SELECT team_invite_code rows via direct SQL", async () => {
    const fx = await seedUserOrgProject("h1-sel-admin");
    const seed = superuserPool();
    try {
      await seed`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'h1seladmin', 'member')`;
      await seed`UPDATE piyaz_auth."member" SET "role" = 'admin'
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
        expect(rows[0].code).toBe("h1seladmin");
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("regular member CANNOT UPDATE a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("h7-update-member");
    const seed = superuserPool();
    try {
      await seed`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'h7updmember', 'member')`;
      await seed`UPDATE piyaz_auth."member" SET "role" = 'member'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const updated = await tx<{ id: string }[]>`
          UPDATE team_invite_code SET revoked_at = NOW()
          WHERE organization_id = ${fx.organizationId}
          RETURNING id`;
        expect(updated.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }

    const verify = superuserPool();
    try {
      const [row] = await verify<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM team_invite_code WHERE organization_id = ${fx.organizationId}`;
      expect(row.revoked_at).toBeNull();
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("regular member CANNOT DELETE a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("h7-delete-member");
    const seed = superuserPool();
    try {
      await seed`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'h7delmember', 'member')`;
      await seed`UPDATE piyaz_auth."member" SET "role" = 'member'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const deleted = await tx<{ id: string }[]>`
          DELETE FROM team_invite_code WHERE organization_id = ${fx.organizationId}
          RETURNING id`;
        expect(deleted.length).toBe(0);
      });
    } finally {
      await c.end({ timeout: 5 });
    }

    const verify = superuserPool();
    try {
      const [row] = await verify<{ code: string }[]>`
        SELECT code FROM team_invite_code WHERE organization_id = ${fx.organizationId}`;
      expect(row.code).toBe("h7delmember");
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  test("admin CAN UPDATE a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("h7-update-admin");
    const seed = superuserPool();
    try {
      await seed`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'h7updadmin', 'member')`;
      await seed`UPDATE piyaz_auth."member" SET "role" = 'admin'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const updated = await tx<{ id: string }[]>`
          UPDATE team_invite_code SET revoked_at = NOW()
          WHERE organization_id = ${fx.organizationId}
          RETURNING id`;
        expect(updated.length).toBe(1);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("admin CAN DELETE a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("h7-delete-admin");
    const seed = superuserPool();
    try {
      await seed`INSERT INTO team_invite_code (organization_id, code, default_role)
                 VALUES (${fx.organizationId}, 'h7deladmin', 'member')`;
      await seed`UPDATE piyaz_auth."member" SET "role" = 'admin'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const deleted = await tx<{ id: string }[]>`
          DELETE FROM team_invite_code WHERE organization_id = ${fx.organizationId}
          RETURNING id`;
        expect(deleted.length).toBe(1);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });
});
