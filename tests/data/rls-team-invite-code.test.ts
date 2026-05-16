import { afterEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { getConnectionString } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";
import { appUserConnect, seedUserOrgProject } from "@/tests/setup/seed";

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
    const seed = postgres(getConnectionString(), { max: 1 });
    try {
      await seed`UPDATE neon_auth."member" SET "role" = 'member'
                 WHERE "userId" = ${fx.userId} AND "organizationId" = ${fx.organizationId}`;
    } finally {
      await seed.end({ timeout: 5 });
    }

    const c = appUserConnect();
    try {
      await expect(
        c.begin(async (tx) => {
          await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
          await tx`INSERT INTO team_invite_code (organization_id, code, default_role)
                   VALUES (${fx.organizationId}, 'BADCODE1', 'member')`;
        }),
      ).rejects.toThrow(/row-level security|violates row-level security/i);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("admin CAN INSERT a team_invite_code row via direct SQL", async () => {
    const fx = await seedUserOrgProject("ic-admin");
    const seed = postgres(getConnectionString(), { max: 1 });
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

  test("any member CAN SELECT team_invite_code rows for their org", async () => {
    const fx = await seedUserOrgProject("ic-select");
    const seed = postgres(getConnectionString(), { max: 1 });
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
