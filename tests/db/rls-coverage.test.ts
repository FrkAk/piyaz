import { describe, expect, test } from "bun:test";
import { superuserPool } from "@/tests/setup/global";

describe("RLS coverage — every public.* table is enabled + forced", () => {
  test("relrowsecurity = true and relforcerowsecurity = true for every public table", async () => {
    const sql = superuserPool();
    try {
      const rows = await sql<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relkind = 'r'
          AND relname NOT IN ('__drizzle_migrations')
        ORDER BY relname
      `;
      const missing = rows.filter(
        (r) => !r.relrowsecurity || !r.relforcerowsecurity,
      );
      if (missing.length > 0) {
        const summary = missing
          .map(
            (r) =>
              `${r.relname} (relrowsecurity=${r.relrowsecurity}, relforcerowsecurity=${r.relforcerowsecurity})`,
          )
          .join("\n  ");
        throw new Error(
          `Tables missing RLS enablement or FORCE:\n  ${summary}\n` +
            `Add .enableRLS() in lib/db/schema.ts (or team-schema.ts) and an ALTER TABLE ... FORCE ROW LEVEL SECURITY in docker/rls-policies.sql.`,
        );
      }
      expect(missing.length).toBe(0);
      expect(rows.length).toBeGreaterThanOrEqual(8);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("role BYPASSRLS attributes match the three-role split", async () => {
    const sql = superuserPool();
    try {
      const rows = await sql<{ rolname: string; rolbypassrls: boolean }[]>`
        SELECT rolname, rolbypassrls
        FROM pg_roles
        WHERE rolname IN ('app_user', 'service_role', 'auth_role')
        ORDER BY rolname
      `;
      const byName = Object.fromEntries(rows.map((r) => [r.rolname, r.rolbypassrls]));
      expect(byName.app_user).toBe(false);
      expect(byName.auth_role).toBe(false);
      expect(byName.service_role).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("every public.* table has at least one policy attached", async () => {
    const sql = superuserPool();
    try {
      const rows = await sql<
        { tablename: string; policy_count: number }[]
      >`
        SELECT c.relname AS tablename, count(p.polname)::int AS policy_count
        FROM pg_class c
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind = 'r'
          AND c.relname NOT IN ('__drizzle_migrations')
        GROUP BY c.relname
        ORDER BY c.relname
      `;
      const unpoliced = rows.filter((r) => r.policy_count === 0);
      if (unpoliced.length > 0) {
        throw new Error(
          `Tables with RLS enabled but NO policies — every query default-denies:\n  ${unpoliced
            .map((r) => r.tablename)
            .join("\n  ")}`,
        );
      }
      expect(unpoliced.length).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
