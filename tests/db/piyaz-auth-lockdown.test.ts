import { afterEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { appUserConnect, seedUserOrgProject } from "@/tests/setup/seed";
import { getConnectionString, superuserPool } from "@/tests/setup/global";
import { expectQueryRejects } from "@/tests/setup/expect-query";

afterEach(async () => {
  await truncateAll();
});

describe("app_user piyaz_auth lockdown", () => {
  const tables = [
    "user",
    "session",
    "account",
    "verification",
    "organization",
    "member",
    "invitation",
    "oauthAccessToken",
    "oauthRefreshToken",
    "oauthConsent",
    "oauthClient",
    "jwks",
  ];

  for (const t of tables) {
    test(`app_user cannot SELECT from piyaz_auth.${t}`, async () => {
      const c = appUserConnect();
      await expectQueryRejects(
        c.unsafe(`SELECT 1 FROM piyaz_auth."${t}" LIMIT 1`),
        /permission denied/i,
      );
    });
  }

  test("app_user can call public.current_user_has_any_membership() — returns false with no GUC", async () => {
    const c = appUserConnect();
    try {
      const rows = await c<{ current_user_has_any_membership: boolean }[]>`
        SELECT public.current_user_has_any_membership()
      `;
      expect(rows[0].current_user_has_any_membership).toBe(false);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("app_user can call public.current_user_org_ids() — empty with no GUC", async () => {
    const c = appUserConnect();
    try {
      const rows = await c<{ current_user_org_ids: string[] | null }[]>`
        SELECT public.current_user_org_ids()
      `;
      const arr = rows[0].current_user_org_ids ?? [];
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.length).toBe(0);
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("public.current_user_org_ids() returns the caller's orgs under the right GUC", async () => {
    const fx = await seedUserOrgProject("lockdown-org-ids");
    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
        const rows = await tx<{ current_user_org_ids: string[] }[]>`
          SELECT public.current_user_org_ids()
        `;
        expect(rows[0].current_user_org_ids).toContain(fx.organizationId);
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("public.current_user_org_ids() does NOT leak another team's org under the wrong GUC", async () => {
    const teamA = await seedUserOrgProject("lockdown-leak-a");
    const teamB = await seedUserOrgProject("lockdown-leak-b");
    const c = appUserConnect();
    try {
      await c.begin(async (tx) => {
        await tx`SELECT set_config('app.user_id', ${teamB.userId}, true)`;
        const rows = await tx<{ current_user_org_ids: string[] }[]>`
          SELECT public.current_user_org_ids()
        `;
        expect(rows[0].current_user_org_ids).not.toContain(
          teamA.organizationId,
        );
      });
    } finally {
      await c.end({ timeout: 5 });
    }
  });

  test("app_user has zero rows in information_schema.table_privileges for schema piyaz_auth", async () => {
    // The runtime SELECT-deny probes above prove the surface is
    // unreachable, but a catalog assertion is the static-shape backup —
    // a future docker/grants-auth.sql edit that accidentally added a grant
    // would silently widen the blast radius. Pin the contract.
    const su = superuserPool();
    try {
      const rows = await su<
        Array<{ grantee: string; table_name: string; privilege_type: string }>
      >`
        SELECT grantee, table_name, privilege_type
        FROM information_schema.table_privileges
        WHERE grantee = 'app_user'
          AND table_schema = 'piyaz_auth'
      `;
      const found = rows.map((r) => `${r.table_name}.${r.privilege_type}`);
      expect(
        found,
        `app_user must have zero table privileges in piyaz_auth (found: ${found.join(", ")})`,
      ).toEqual([]);
    } finally {
      await su.end({ timeout: 5 });
    }
  });
});

describe("auth_role public.* lockdown", () => {
  // auth_role is Better Auth's connection — it must have ZERO grants on
  // public.* so a compromise of the BA path cannot reach app data. A
  // future docker/grants.sql edit that accidentally granted SELECT (or
  // worse) on a public table would silently widen the blast radius.
  // These tests pin the contract.
  const publicTables = [
    "projects",
    "tasks",
    "task_edges",
    "task_assignees",
    "task_acceptance_criteria",
    "task_decisions",
    "task_links",
    "team_invite_code",
  ];

  function authRolePool() {
    const url = new URL(getConnectionString());
    url.username = "auth_role";
    url.password = "auth_role";
    return postgres(url.toString(), { max: 1, idle_timeout: 5 });
  }

  for (const t of publicTables) {
    test(`auth_role cannot SELECT from public.${t}`, async () => {
      const c = authRolePool();
      try {
        await expectQueryRejects(
          c.unsafe(`SELECT 1 FROM public."${t}" LIMIT 1`),
          /permission denied/i,
        );
      } finally {
        await c.end({ timeout: 5 });
      }
    });
  }

  test("auth_role has no table-level privileges on any public.* table", async () => {
    // USAGE on the schema is granted to PUBLIC by default on Postgres ≤14
    // and to pg_database_owner on ≥15; the per-table privileges are the
    // meaningful contract. The per-table SELECT/INSERT/UPDATE/DELETE
    // probes above already prove the runtime path is locked down; this
    // catalog assertion is the static-shape backup.
    const c = authRolePool();
    try {
      for (const t of publicTables) {
        const [row] = await c<
          Array<{
            sel: boolean;
            ins: boolean;
            upd: boolean;
            del: boolean;
          }>
        >`
          SELECT
            has_table_privilege('auth_role', 'public.' || ${t}, 'SELECT') AS sel,
            has_table_privilege('auth_role', 'public.' || ${t}, 'INSERT') AS ins,
            has_table_privilege('auth_role', 'public.' || ${t}, 'UPDATE') AS upd,
            has_table_privilege('auth_role', 'public.' || ${t}, 'DELETE') AS del
        `;
        expect(row.sel, `auth_role must NOT have SELECT on public.${t}`).toBe(
          false,
        );
        expect(row.ins, `auth_role must NOT have INSERT on public.${t}`).toBe(
          false,
        );
        expect(row.upd, `auth_role must NOT have UPDATE on public.${t}`).toBe(
          false,
        );
        expect(row.del, `auth_role must NOT have DELETE on public.${t}`).toBe(
          false,
        );
      }
    } finally {
      await c.end({ timeout: 5 });
    }
  });
});

describe("service_role piyaz_auth grants pin the call-site contract", () => {
  // The data-layer call sites in lib/data/oauth-session.ts and
  // lib/data/account.ts rely on a documented, MINIMAL set of grants. If
  // grants-auth.sql ever loses one of these, the affected UI surface dies
  // with "permission denied" at runtime (e.g. the settings agent tab and
  // session revocation). Pin the required privileges so a future grant
  // edit can't silently widen or narrow the contract.
  const requiredGrants: Array<{
    table: string;
    needs: ReadonlyArray<"SELECT" | "INSERT" | "UPDATE" | "DELETE">;
  }> = [
    { table: "oauthClient", needs: ["SELECT"] },
    { table: "oauthRefreshToken", needs: ["SELECT", "UPDATE", "DELETE"] },
    { table: "oauthAccessToken", needs: ["SELECT", "DELETE"] },
    { table: "oauthConsent", needs: ["SELECT", "DELETE"] },
    { table: "session", needs: ["SELECT", "UPDATE"] },
    { table: "member", needs: ["SELECT"] },
    { table: "organization", needs: ["SELECT"] },
    { table: "user", needs: ["SELECT"] },
    { table: "invitation", needs: ["SELECT"] },
  ];

  function serviceRolePool() {
    const url = new URL(getConnectionString());
    url.username = "service_role";
    url.password = "service_role";
    return postgres(url.toString(), { max: 1, idle_timeout: 5 });
  }

  for (const { table, needs } of requiredGrants) {
    test(`service_role has the documented grants on piyaz_auth.${table}`, async () => {
      const c = serviceRolePool();
      try {
        for (const priv of needs) {
          const [row] = await c<Array<{ has: boolean }>>`
            SELECT has_table_privilege(
              'service_role',
              ${'piyaz_auth."' + table + '"'},
              ${priv}
            ) AS has
          `;
          expect(
            row.has,
            `service_role must have ${priv} on piyaz_auth.${table}`,
          ).toBe(true);
        }
      } finally {
        await c.end({ timeout: 5 });
      }
    });
  }
});
