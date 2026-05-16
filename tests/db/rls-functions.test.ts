import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import {
  appUserConnect,
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { expectQueryRejects } from "@/tests/setup/expect-query";

afterEach(async () => {
  await truncateAll();
});

/**
 * Tests for the SECURITY DEFINER helper functions in docker/rls-functions.sql.
 * Functions execute under their owner's privileges so they can read/write
 * team_invite_code rows without requiring the calling user to be a member
 * of the target org.
 */
describe("invite-code SECURITY DEFINER functions", () => {
  async function seedCode(opts: {
    orgId: string;
    code: string;
    maxUses?: number | null;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
    useCount?: number;
    reservedBy?: string | null;
    reservedUntil?: Date | null;
  }): Promise<{ id: string }> {
    const sr = serviceRoleConnect();
    try {
      const rows = await sr<{ id: string }[]>`
        INSERT INTO team_invite_code (
          organization_id, code, default_role, max_uses, expires_at, revoked_at,
          use_count, reserved_by, reserved_until
        ) VALUES (
          ${opts.orgId}, ${opts.code}, 'member',
          ${opts.maxUses ?? null}, ${opts.expiresAt ?? null}, ${opts.revokedAt ?? null},
          ${opts.useCount ?? 0},
          ${opts.reservedBy ?? null}, ${opts.reservedUntil ?? null}
        )
        RETURNING id
      `;
      return rows[0];
    } finally {
      await sr.end({ timeout: 5 });
    }
  }

  test("lookup_team_invite_code returns the four diagnostic fields when run as app_user without GUC", async () => {
    const fx = await seedUserOrgProject("lookup-1");
    await seedCode({
      orgId: fx.organizationId,
      code: "LOOKUP1",
      maxUses: 5,
      useCount: 2,
    });
    const c = appUserConnect();
    try {
      const rows = await c<Array<{
        revoked_at: Date | null;
        expires_at: Date | null;
        max_uses: number | null;
        use_count: number;
      }>>`SELECT revoked_at, expires_at, max_uses, use_count FROM public.lookup_team_invite_code(${"LOOKUP1"})`;
      expect(rows.length).toBe(1);
      expect(rows[0].revoked_at).toBeNull();
      expect(rows[0].max_uses).toBe(5);
      expect(rows[0].use_count).toBe(2);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("lookup_team_invite_code does NOT return id / organization_id / default_role", async () => {
    const fx = await seedUserOrgProject("lookup-shape");
    await seedCode({ orgId: fx.organizationId, code: "LOOKUPSHAPE" });
    const c = appUserConnect();
    await expectQueryRejects(
      c`SELECT id FROM public.lookup_team_invite_code(${"LOOKUPSHAPE"})`,
      /column "id" does not exist/i,
    );
    await expectQueryRejects(
      c`SELECT organization_id FROM public.lookup_team_invite_code(${"LOOKUPSHAPE"})`,
      /column "organization_id" does not exist/i,
    );
    await expectQueryRejects(
      c`SELECT default_role FROM public.lookup_team_invite_code(${"LOOKUPSHAPE"})`,
      /column "default_role" does not exist/i,
    );
  });

  test("reserve_team_invite_code_slot increments use_count and records reserved_by", async () => {
    const fx = await seedUserOrgProject("reserve-1");
    const seeded = await seedCode({
      orgId: fx.organizationId,
      code: "RESERVE1",
      useCount: 0,
    });
    const c = appUserConnect();
    try {
      const rows = await c<Array<{ id: string }>>`
        SELECT id FROM public.reserve_team_invite_code_slot(${"RESERVE1"}, ${fx.userId}::uuid)
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(seeded.id);
    } finally {
      await c.end({ timeout: 5 });
    }
    const sr = serviceRoleConnect();
    try {
      const [row] = await sr<Array<{ use_count: number; reserved_by: string | null }>>`
        SELECT use_count, reserved_by FROM team_invite_code WHERE id = ${seeded.id}
      `;
      expect(row.use_count).toBe(1);
      expect(row.reserved_by).toBe(fx.userId);
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("reserve_team_invite_code_slot returns empty when code is revoked", async () => {
    const fx = await seedUserOrgProject("reserve-2");
    await seedCode({
      orgId: fx.organizationId,
      code: "REVOKED1",
      revokedAt: new Date(),
    });
    const c = appUserConnect();
    try {
      const rows = await c`SELECT * FROM public.reserve_team_invite_code_slot(${"REVOKED1"}, ${fx.userId}::uuid)`;
      expect(rows.length).toBe(0);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("reserve_team_invite_code_slot returns empty when code is expired", async () => {
    const fx = await seedUserOrgProject("reserve-3");
    await seedCode({
      orgId: fx.organizationId,
      code: "EXPIRED1",
      expiresAt: new Date(Date.now() - 1000),
    });
    const c = appUserConnect();
    try {
      const rows = await c`SELECT * FROM public.reserve_team_invite_code_slot(${"EXPIRED1"}, ${fx.userId}::uuid)`;
      expect(rows.length).toBe(0);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("reserve_team_invite_code_slot returns empty when use_count >= max_uses", async () => {
    const fx = await seedUserOrgProject("reserve-4");
    await seedCode({
      orgId: fx.organizationId,
      code: "EXHAUSTED1",
      maxUses: 1,
      useCount: 1,
    });
    const c = appUserConnect();
    try {
      const rows = await c`SELECT * FROM public.reserve_team_invite_code_slot(${"EXHAUSTED1"}, ${fx.userId}::uuid)`;
      expect(rows.length).toBe(0);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("release with succeeded=false decrements use_count and clears reservation", async () => {
    const fx = await seedUserOrgProject("release-false");
    const seeded = await seedCode({
      orgId: fx.organizationId,
      code: "RELFALSE",
      useCount: 1,
      reservedBy: fx.userId,
      reservedUntil: new Date(Date.now() + 15 * 60_000),
    });
    const c = appUserConnect();
    try {
      const rows = await c<Array<{ release_team_invite_code_slot: boolean }>>`
        SELECT public.release_team_invite_code_slot(${seeded.id}::uuid, ${fx.userId}::uuid, FALSE)
      `;
      expect(rows[0].release_team_invite_code_slot).toBe(true);
    } finally {
      await c.end({ timeout: 5 });
    }
    const sr = serviceRoleConnect();
    try {
      const [row] = await sr<Array<{
        use_count: number;
        reserved_by: string | null;
        reserved_until: Date | null;
      }>>`
        SELECT use_count, reserved_by, reserved_until
        FROM team_invite_code WHERE id = ${seeded.id}
      `;
      expect(row.use_count).toBe(0);
      expect(row.reserved_by).toBeNull();
      expect(row.reserved_until).toBeNull();
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("release with succeeded=true keeps use_count and clears reservation", async () => {
    const fx = await seedUserOrgProject("release-true");
    const seeded = await seedCode({
      orgId: fx.organizationId,
      code: "RELTRUE",
      useCount: 1,
      reservedBy: fx.userId,
      reservedUntil: new Date(Date.now() + 15 * 60_000),
    });
    const c = appUserConnect();
    try {
      const rows = await c<Array<{ release_team_invite_code_slot: boolean }>>`
        SELECT public.release_team_invite_code_slot(${seeded.id}::uuid, ${fx.userId}::uuid, TRUE)
      `;
      expect(rows[0].release_team_invite_code_slot).toBe(true);
    } finally {
      await c.end({ timeout: 5 });
    }
    const sr = serviceRoleConnect();
    try {
      const [row] = await sr<Array<{
        use_count: number;
        reserved_by: string | null;
        reserved_until: Date | null;
      }>>`
        SELECT use_count, reserved_by, reserved_until
        FROM team_invite_code WHERE id = ${seeded.id}
      `;
      expect(row.use_count).toBe(1);
      expect(row.reserved_by).toBeNull();
      expect(row.reserved_until).toBeNull();
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("release with succeeded=false floors use_count at zero", async () => {
    const fx = await seedUserOrgProject("release-floor");
    const seeded = await seedCode({
      orgId: fx.organizationId,
      code: "RELFLOOR",
      useCount: 0,
      reservedBy: fx.userId,
      reservedUntil: new Date(Date.now() + 15 * 60_000),
    });
    const c = appUserConnect();
    try {
      const rows = await c<Array<{ release_team_invite_code_slot: boolean }>>`
        SELECT public.release_team_invite_code_slot(${seeded.id}::uuid, ${fx.userId}::uuid, FALSE)
      `;
      expect(rows[0].release_team_invite_code_slot).toBe(true);
    } finally {
      await c.end({ timeout: 5 });
    }
    const sr = serviceRoleConnect();
    try {
      const [row] = await sr<Array<{ use_count: number }>>`
        SELECT use_count FROM team_invite_code WHERE id = ${seeded.id}
      `;
      expect(row.use_count).toBe(0);
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("release returns false and is a no-op when caller did not reserve (H1)", async () => {
    const fxA = await seedUserOrgProject("release-cross-a");
    const fxB = await seedUserOrgProject("release-cross-b");
    const seeded = await seedCode({
      orgId: fxA.organizationId,
      code: "CROSSREL",
      useCount: 1,
      reservedBy: fxA.userId,
      reservedUntil: new Date(Date.now() + 15 * 60_000),
    });

    const cb = appUserConnect();
    try {
      const finalize = await cb<Array<{ release_team_invite_code_slot: boolean }>>`
        SELECT public.release_team_invite_code_slot(${seeded.id}::uuid, ${fxB.userId}::uuid, TRUE)
      `;
      expect(finalize[0].release_team_invite_code_slot).toBe(false);

      const rollback = await cb<Array<{ release_team_invite_code_slot: boolean }>>`
        SELECT public.release_team_invite_code_slot(${seeded.id}::uuid, ${fxB.userId}::uuid, FALSE)
      `;
      expect(rollback[0].release_team_invite_code_slot).toBe(false);
    } finally {
      await cb.end({ timeout: 5 });
    }

    const sr = serviceRoleConnect();
    try {
      const [row] = await sr<Array<{
        use_count: number;
        reserved_by: string | null;
      }>>`
        SELECT use_count, reserved_by FROM team_invite_code WHERE id = ${seeded.id}
      `;
      expect(row.use_count).toBe(1);
      expect(row.reserved_by).toBe(fxA.userId);
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("release returns false on a nonexistent reservation id (M5)", async () => {
    const fx = await seedUserOrgProject("release-bogus");
    const c = appUserConnect();
    try {
      const rows = await c<Array<{ release_team_invite_code_slot: boolean }>>`
        SELECT public.release_team_invite_code_slot(
          '00000000-0000-0000-0000-000000000000'::uuid,
          ${fx.userId}::uuid,
          TRUE
        )
      `;
      expect(rows[0].release_team_invite_code_slot).toBe(false);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("reserve_team_invite_code_slot sets reserved_until ~15 minutes ahead", async () => {
    const fx = await seedUserOrgProject("ttl-1");
    await seedCode({ orgId: fx.organizationId, code: "TTL1", useCount: 0 });
    const c = appUserConnect();
    try {
      await c`SELECT * FROM public.reserve_team_invite_code_slot(${"TTL1"}, ${fx.userId}::uuid)`;
    } finally {
      await c.end({ timeout: 5 });
    }
    const sr = serviceRoleConnect();
    try {
      const [row] = await sr<Array<{ reserved_until: Date | null }>>`
        SELECT reserved_until FROM team_invite_code WHERE code = ${"TTL1"}
      `;
      expect(row.reserved_until).not.toBeNull();
      const aheadMs = (row.reserved_until as Date).getTime() - Date.now();
      expect(aheadMs).toBeGreaterThan(14 * 60_000);
      expect(aheadMs).toBeLessThan(16 * 60_000);
    } finally {
      await sr.end({ timeout: 5 });
    }
  });

  test("reserve sweeps a stale (crashed) reservation before a new attempt — maxUses=1 case", async () => {
    const stale = await seedUserOrgProject("ttl-sweep-prev");
    const fresh = await seedUserOrgProject("ttl-sweep-new");
    const seeded = await seedCode({
      orgId: stale.organizationId,
      code: "SWEEP1",
      maxUses: 1,
      useCount: 1,
      reservedBy: stale.userId,
      reservedUntil: new Date(Date.now() - 60_000),
    });

    const c = appUserConnect();
    let reservedRows: Array<{ id: string }> = [];
    try {
      reservedRows = await c<Array<{ id: string }>>`
        SELECT id FROM public.reserve_team_invite_code_slot(${"SWEEP1"}, ${fresh.userId}::uuid)
      `;
    } finally {
      await c.end({ timeout: 5 });
    }
    expect(reservedRows.length).toBe(1);

    const sr2 = serviceRoleConnect();
    try {
      const [row] = await sr2<Array<{
        use_count: number;
        reserved_until: Date | null;
        reserved_by: string | null;
      }>>`
        SELECT use_count, reserved_until, reserved_by FROM team_invite_code WHERE id = ${seeded.id}
      `;
      expect(row.use_count).toBe(1);
      expect(row.reserved_until).not.toBeNull();
      expect(row.reserved_by).toBe(fresh.userId);
    } finally {
      await sr2.end({ timeout: 5 });
    }
  });

  test("EXECUTE is granted to app_user only (no PUBLIC, no service_role)", async () => {
    // Tighter and faster than spinning up a throwaway role: query the
    // catalog directly. has_function_privilege returns false for any role
    // that wasn't granted EXECUTE. We assert: app_user has it; PUBLIC and
    // service_role do not. (service_role keeps DML on the table but is not
    // expected to call these functions — it can bypass RLS directly.)
    const sr = serviceRoleConnect();
    try {
      const fns = [
        "public.lookup_team_invite_code(text)",
        "public.reserve_team_invite_code_slot(text, uuid)",
        "public.release_team_invite_code_slot(uuid, uuid, boolean)",
      ];
      for (const fn of fns) {
        const [row] = await sr<
          Array<{ app_user: boolean; public_role: boolean; service_role: boolean }>
        >`
          SELECT has_function_privilege('app_user', ${fn}, 'EXECUTE') AS app_user,
                 has_function_privilege('public', ${fn}, 'EXECUTE') AS public_role,
                 has_function_privilege('service_role', ${fn}, 'EXECUTE') AS service_role
        `;
        expect(row.app_user).toBe(true);
        expect(row.public_role).toBe(false);
        expect(row.service_role).toBe(false);
      }
    } finally {
      await sr.end({ timeout: 5 });
    }
  });
});

describe("CVE-2018-1058 hardening — search_path", () => {
  test("every SECURITY DEFINER function in public.* ends search_path with pg_temp", async () => {
    const sr = serviceRoleConnect();
    const rows = await sr<Array<{ proname: string; proconfig: string[] | null }>>`
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      INNER JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef = true
      ORDER BY p.proname
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const settings = row.proconfig ?? [];
      const searchPath = settings.find((s) => s.toLowerCase().startsWith("search_path="));
      expect(searchPath, `${row.proname}: missing SET search_path`).toBeDefined();
      expect(
        (searchPath ?? "").endsWith("pg_temp"),
        `${row.proname}: search_path must end with pg_temp (got ${searchPath})`,
      ).toBe(true);
    }
  });

  test("trigger functions reject_*_change pin search_path", async () => {
    const sr = serviceRoleConnect();
    const rows = await sr<Array<{ proname: string; proconfig: string[] | null }>>`
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      INNER JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'reject_projects_organization_id_change',
          'reject_tasks_project_id_change'
        )
    `;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const settings = row.proconfig ?? [];
      const searchPath = settings.find((s) => s.toLowerCase().startsWith("search_path="));
      expect(searchPath, `${row.proname}: missing SET search_path`).toBeDefined();
      expect((searchPath ?? "").endsWith("pg_temp")).toBe(true);
    }
  });

  test("app_user cannot CREATE TEMP TABLE (TEMPORARY revoked from PUBLIC)", async () => {
    const c = appUserConnect();
    // PG 17 emits "...create temporary tables in database"; pre-17 emits "...for database".
    await expectQueryRejects(
      c`CREATE TEMP TABLE _temp_probe (x int)`,
      /permission denied (to create temporary tables in database|for database)/,
    );
  });

  test("has_database_privilege reports false for TEMPORARY on app_user", async () => {
    const sr = serviceRoleConnect();
    const [row] = await sr<Array<{ has_temp: boolean }>>`
      SELECT has_database_privilege('app_user', current_database(), 'TEMPORARY') AS has_temp
    `;
    expect(row.has_temp).toBe(false);
  });
});

describe("is_caller_in_invitation_org SECURITY DEFINER", () => {
  async function seedInvitation(orgId: string, email: string): Promise<{ id: string }> {
    const su = superuserPool();
    const [row] = await su<{ id: string }[]>`
      INSERT INTO neon_auth."invitation"
        ("organizationId", "email", "role", "status", "expiresAt", "inviterId")
      VALUES (
        ${orgId}, ${email}, 'member', 'pending',
        ${new Date(Date.now() + 7 * 86400_000)},
        (SELECT "userId" FROM neon_auth."member" WHERE "organizationId" = ${orgId} LIMIT 1)
      )
      RETURNING id
    `;
    return row;
  }

  async function callPredicate(
    callerUserId: string,
    invitationId: string,
    expectedOrgId: string,
  ): Promise<boolean> {
    const c = appUserConnect();
    return await c.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${callerUserId}, true)`;
      const [row] = await tx<Array<{ ok: boolean }>>`
        SELECT public.is_caller_in_invitation_org(${invitationId}::uuid, ${expectedOrgId}::uuid) AS ok
      `;
      return row.ok;
    });
  }

  test("returns true when caller is in invitation's org and expected matches", async () => {
    const fx = await seedUserOrgProject("inv-hit");
    const inv = await seedInvitation(fx.organizationId, "hit@test.local");
    expect(await callPredicate(fx.userId, inv.id, fx.organizationId)).toBe(true);
  });

  test("returns false when expected org does not match the invitation's org (binding)", async () => {
    const fxA = await seedUserOrgProject("inv-bind-a");
    const fxB = await seedUserOrgProject("inv-bind-b");
    const su = superuserPool();
    await su`
      INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${fxB.organizationId}, ${fxA.userId}, 'member', now())
    `;
    const inv = await seedInvitation(fxA.organizationId, "bind@test.local");
    expect(await callPredicate(fxA.userId, inv.id, fxB.organizationId)).toBe(false);
  });

  test("returns false when caller is not a member of the invitation's org", async () => {
    const fxA = await seedUserOrgProject("inv-cross-a");
    const fxB = await seedUserOrgProject("inv-cross-b");
    const inv = await seedInvitation(fxA.organizationId, "cross@test.local");
    expect(await callPredicate(fxB.userId, inv.id, fxA.organizationId)).toBe(false);
  });

  test("returns false on a nonexistent invitation id", async () => {
    const fx = await seedUserOrgProject("inv-bogus");
    const bogus = "00000000-0000-0000-0000-000000000000";
    expect(await callPredicate(fx.userId, bogus, fx.organizationId)).toBe(false);
  });
});

describe("SECURITY DEFINER catalog invariants", () => {
  test("every public.* SECURITY DEFINER function is owned by a BYPASSRLS role", async () => {
    // A SECURITY DEFINER body runs with the owner's row-level visibility.
    // If the owner is ever flipped to a NOBYPASSRLS role, every definer
    // call would suddenly evaluate RLS as that role's identity (typically
    // empty), silently breaking the invite-code join flow without raising.
    // This test pins the contract: every definer must be owned by a role
    // whose `rolbypassrls = true`.
    const sr = serviceRoleConnect();
    const rows = await sr<
      Array<{ proname: string; rolbypassrls: boolean; rolname: string }>
    >`
      SELECT p.proname, r.rolname, r.rolbypassrls
      FROM pg_proc p
      INNER JOIN pg_namespace n ON n.oid = p.pronamespace
      INNER JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'public'
        AND p.prosecdef = true
      ORDER BY p.proname
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        row.rolbypassrls,
        `${row.proname}: owner ${row.rolname} must be BYPASSRLS (rolbypassrls=true)`,
      ).toBe(true);
    }
  });

  test("EXECUTE grant matrix matches the expected (app_user, public, service_role) tuple per function", async () => {
    // PUBLIC must be denied on every public.* SECURITY DEFINER. app_user
    // and service_role get EXECUTE selectively per function (the
    // *AsAdmin definers are service_role-only). Any drift here is a
    // privilege-escalation candidate and warrants a docker/grants.sql
    // diff.
    const sr = serviceRoleConnect();
    const rows = await sr<
      Array<{
        proname: string;
        public_role: boolean;
        app_user: boolean;
        service_role: boolean;
      }>
    >`
      SELECT
        p.oid::regprocedure::text AS proname,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_role,
        has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
      FROM pg_proc p
      INNER JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef = true
      ORDER BY p.proname
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        row.public_role,
        `${row.proname}: PUBLIC must NOT have EXECUTE (CVE-2018-1058 hardening)`,
      ).toBe(false);
      // Every definer is granted to app_user OR service_role (or both);
      // a definer with no grants is dead code and worth flagging.
      expect(
        row.app_user || row.service_role,
        `${row.proname}: no role has EXECUTE — orphan definer?`,
      ).toBe(true);
    }
  });
});
