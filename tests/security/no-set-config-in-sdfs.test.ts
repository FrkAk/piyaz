import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Invariant: only the transaction-boundary owners — `lib/db/rls.ts` plus
 * the `withUserContextRead` backends `lib/db/rls-read.node.ts` and
 * `lib/db/rls-read.workers.ts` — may issue `set_config('app.user_id', ...)`.
 *
 * `public.current_user_org_ids()` is `STABLE`, so Postgres memoizes its
 * result for the duration of a single statement. The function reads
 * `app.user_id` from the GUC, but the GUC is NOT part of the function's
 * argument list — the planner can therefore reuse a cached result across
 * rows even if the GUC changed. If any SECURITY DEFINER or migration ever
 * flipped `app.user_id` mid-statement, RLS policies that already
 * memoized the membership array would silently see the new GUC's
 * authority on subsequent rows. The JS wrappers that own a transaction
 * boundary (and set the GUC exactly once, before any read) are the only
 * allowed call sites; this test pins the contract so a future
 * SDF/migration cannot quietly land a `set_config('app.user_id', ...)`
 * and break the STABLE-cache invariant. The read path's keyword guard
 * (`lib/db/read-guard.ts`) is the matching runtime belt: it rejects
 * `set_config` inside any `withUserContextRead` build statement.
 */
describe("no set_config('app.user_id', ...) outside lib/db/rls.ts", () => {
  const SET_CONFIG_APP_USER_ID = /set_config\s*\(\s*['"]app\.user_id/i;

  function listSqlFiles(dir: string): string[] {
    let out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        out = out.concat(listSqlFiles(p));
      } else if (entry.name.endsWith(".sql")) {
        out.push(p);
      }
    }
    return out;
  }

  test("no docker/*.sql file calls set_config('app.user_id', ...)", () => {
    const files = listSqlFiles(join(process.cwd(), "docker"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      expect(
        SET_CONFIG_APP_USER_ID.test(content),
        `${f} must not call set_config('app.user_id', ...)`,
      ).toBe(false);
    }
  });

  test("no drizzle/*.sql migration calls set_config('app.user_id', ...)", () => {
    const dir = join(process.cwd(), "drizzle");
    const files = listSqlFiles(dir);
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      expect(
        SET_CONFIG_APP_USER_ID.test(content),
        `${f} must not call set_config('app.user_id', ...)`,
      ).toBe(false);
    }
  });

  test("the rls transaction-boundary owners are the sole TS call sites", () => {
    const re = /set_config\s*\(\s*['"`]app\.user_id/i;
    const root = process.cwd();
    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
        if (p.endsWith("/lib/db/rls.ts")) continue;
        if (p.endsWith("/lib/db/rls-read.node.ts")) continue;
        if (p.endsWith("/lib/db/rls-read.workers.ts")) continue;
        // The grep test itself contains the literal string; skip.
        if (p.endsWith("/tests/security/no-set-config-in-sdfs.test.ts"))
          continue;
        const content = readFileSync(p, "utf8");
        if (re.test(content)) offenders.push(p);
      }
    }
    walk(join(root, "lib"));
    walk(join(root, "app"));
    walk(join(root, "components"));
    expect(
      offenders,
      "set_config('app.user_id', ...) is only allowed in lib/db/rls.ts",
    ).toEqual([]);
  });
});
