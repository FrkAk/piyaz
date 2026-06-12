import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { projects } from "@/lib/db/schema";
import { ReadOnlyViolationError, withUserContextRead } from "@/lib/db/rls";
import { unwrapDriverError } from "@/lib/db/errors";
import { normalizeExecuteResult } from "@/lib/db/raw";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";

describe("withUserContextRead userId validation", () => {
  test("rejects a non-UUID userId before building statements", async () => {
    let built = false;
    await expect(
      withUserContextRead("not-a-uuid", (db) => {
        built = true;
        return [db.select({ id: projects.id }).from(projects)];
      }),
    ).rejects.toThrow(/valid UUID/i);
    expect(built).toBe(false);
  });

  test("rejects an empty userId", async () => {
    await expect(
      withUserContextRead("", (db) => [
        db.select({ id: projects.id }).from(projects),
      ]),
    ).rejects.toThrow(/valid UUID/i);
  });
});

describe("withUserContextRead RLS scope", () => {
  afterEach(async () => {
    await truncateAll();
  });

  test("returns only the caller's tenant rows", async () => {
    const teamA = await seedUserOrgProject("read-a");
    await seedUserOrgProject("read-b");

    const [rows] = await withUserContextRead(teamA.userId, (db) => [
      db.select({ id: projects.id }).from(projects),
    ]);

    expect(rows.map((r) => r.id)).toEqual([teamA.projectId]);
  });

  test("wrong-tenant reads return empty", async () => {
    const teamA = await seedUserOrgProject("empty-a");
    const teamB = await seedUserOrgProject("empty-b");

    const [rows] = await withUserContextRead(teamA.userId, (db) => [
      db
        .select({ id: projects.id })
        .from(projects)
        .where(sql`${projects.id} = ${teamB.projectId}`),
    ]);

    expect(rows).toEqual([]);
  });

  test("sets app.user_id for the statements in the same transaction", async () => {
    const fx = await seedUserOrgProject("read-guc");

    const [gucRows] = await withUserContextRead(fx.userId, (db) => [
      db.execute(sql`SELECT current_setting('app.user_id', TRUE) AS uid`),
    ]);

    const [row] = normalizeExecuteResult<{ uid: string }>(gucRows);
    expect(row.uid).toBe(fx.userId);
  });

  test("returns results positionally aligned with the build statements", async () => {
    const fx = await seedUserOrgProject("read-align");

    const [idRows, gucRows, titleRows] = await withUserContextRead(
      fx.userId,
      (db) => [
        db.select({ id: projects.id }).from(projects),
        db.execute(sql`SELECT current_setting('app.user_id', TRUE) AS uid`),
        db.select({ title: projects.title }).from(projects),
      ],
    );

    expect(idRows).toEqual([{ id: fx.projectId }]);
    const [guc] = normalizeExecuteResult<{ uid: string }>(gucRows);
    expect(guc.uid).toBe(fx.userId);
    expect(titleRows).toEqual([{ title: "Project read-align" }]);
  });
});

describe("withUserContextRead read-only guard", () => {
  afterEach(async () => {
    await truncateAll();
  });

  test("rejects an UPDATE smuggled through a raw statement", async () => {
    const fx = await seedUserOrgProject("guard-update");

    await expect(
      withUserContextRead(fx.userId, (db) => [
        db.execute(sql`UPDATE projects SET title = 'pwned'`),
      ]),
    ).rejects.toThrow(ReadOnlyViolationError);

    const su = superuserPool();
    const [row] = await su<{ title: string }[]>`
      SELECT title FROM projects WHERE id = ${fx.projectId}
    `;
    expect(row.title).toBe("Project guard-update");
  });

  test("rejects an INSERT smuggled through a raw statement", async () => {
    const fx = await seedUserOrgProject("guard-insert");

    await expect(
      withUserContextRead(fx.userId, (db) => [
        db.execute(
          sql`INSERT INTO tasks (project_id, title, sequence_number) VALUES (${fx.projectId}, 'x', 1)`,
        ),
      ]),
    ).rejects.toThrow(ReadOnlyViolationError);
  });

  test("rejects statements that do not start with SELECT or WITH", async () => {
    const fx = await seedUserOrgProject("guard-head");

    await expect(
      withUserContextRead(fx.userId, (db) => [
        db.execute(sql`EXPLAIN SELECT 1`),
      ]),
    ).rejects.toThrow(ReadOnlyViolationError);
  });

  test("rejects set_config GUC tampering inside build statements", async () => {
    const fx = await seedUserOrgProject("guard-guc");
    const other = "11111111-1111-1111-1111-111111111111";

    await expect(
      withUserContextRead(fx.userId, (db) => [
        db.execute(sql`SELECT set_config('app.user_id', ${other}, true)`),
      ]),
    ).rejects.toThrow(ReadOnlyViolationError);
  });

  test("rejects advisory lock acquisition inside build statements", async () => {
    const fx = await seedUserOrgProject("guard-lock");

    await expect(
      withUserContextRead(fx.userId, (db) => [
        db.execute(sql`SELECT pg_advisory_xact_lock(42)`),
      ]),
    ).rejects.toThrow(ReadOnlyViolationError);
  });

  test("rejects an empty statement array", async () => {
    const fx = await seedUserOrgProject("guard-empty");

    await expect(
      withUserContextRead(fx.userId, () => [] as never),
    ).rejects.toThrow(/at least one statement/i);
  });

  test("allows quoted identifiers matching forbidden tokens", async () => {
    const fx = await seedUserOrgProject("guard-quoted-ident");

    const [raw] = await withUserContextRead(fx.userId, (db) => [
      db.execute(
        sql`SELECT title AS "update", id AS "merge" FROM projects WHERE id = ${fx.projectId}`,
      ),
    ]);
    const rows = normalizeExecuteResult<{ update: string; merge: string }>(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].update).toBe("Project guard-quoted-ident");
  });

  test("allows string literals matching forbidden tokens", async () => {
    const fx = await seedUserOrgProject("guard-quoted-lit");

    const [raw] = await withUserContextRead(fx.userId, (db) => [
      db.execute(
        sql`SELECT 'merge' AS verb, 'it''s an update' AS note FROM projects WHERE id = ${fx.projectId}`,
      ),
    ]);
    const rows = normalizeExecuteResult<{ verb: string; note: string }>(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("it's an update");
  });

  test("still rejects forbidden tokens outside quoted spans", async () => {
    const fx = await seedUserOrgProject("guard-quoted-mix");
    const other = "11111111-1111-1111-1111-111111111111";

    await expect(
      withUserContextRead(fx.userId, (db) => [
        db.execute(
          sql`SELECT 'harmless', set_config('app.user_id', ${other}, true)`,
        ),
      ]),
    ).rejects.toThrow(ReadOnlyViolationError);
  });

  test("scans dollar-quoted statements unstripped", async () => {
    const fx = await seedUserOrgProject("guard-dollar");

    await expect(
      withUserContextRead(fx.userId, (db) => [
        db.execute(sql`SELECT $$ ' $$, set_config('a','b',true), $$ ' $$`),
      ]),
    ).rejects.toThrow(ReadOnlyViolationError);
  });
});

describe("withUserContextRead database-level READ ONLY", () => {
  beforeAll(async () => {
    const su = superuserPool();
    await su`CREATE SEQUENCE IF NOT EXISTS rls_read_probe_seq`;
    await su`GRANT USAGE ON SEQUENCE rls_read_probe_seq TO app_user`;
  });

  afterEach(async () => {
    await truncateAll();
  });

  test("a write that evades the keyword guard is rejected by Postgres", async () => {
    const fx = await seedUserOrgProject("guard-db");

    let caught: unknown;
    try {
      await withUserContextRead(fx.userId, (db) => [
        db.execute(sql`SELECT nextval('rls_read_probe_seq')`),
      ]);
    } catch (e) {
      caught = e;
    }
    expect(unwrapDriverError(caught)?.code).toBe("25006");
  });
});
