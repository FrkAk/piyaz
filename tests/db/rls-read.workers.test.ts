import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { projects } from "@/lib/db/schema";
import { runUserContextRead } from "@/lib/db/rls-read.workers";
import { withRequestDb } from "@/lib/db/request-scope.workers";
import { ReadOnlyViolationError } from "@/lib/db/read-guard";
import { normalizeExecuteResult } from "@/lib/db/raw";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import {
  installNeonHttpShim,
  type NeonHttpShim,
} from "@/tests/setup/neon-http-shim";
import { superuserPool } from "@/tests/setup/global";

let shim: NeonHttpShim;

beforeAll(async () => {
  shim = installNeonHttpShim();
  const su = superuserPool();
  await su`CREATE SEQUENCE IF NOT EXISTS rls_read_probe_seq`;
  await su`GRANT USAGE ON SEQUENCE rls_read_probe_seq TO app_user`;
});

afterAll(async () => {
  await shim.uninstall();
});

/**
 * Run `fn` inside a Workers request frame wired to the test database, then
 * invoke the frame teardown (a no-op here — the HTTP read path builds no
 * WebSocket pools).
 *
 * @param fn - Body to run inside the frame.
 * @returns Whatever `fn` returns.
 */
async function inRequestFrame<T>(fn: () => Promise<T>): Promise<T> {
  const { result, teardown } = await withRequestDb(fn, {
    databaseUrl: process.env.DATABASE_URL,
  });
  await teardown();
  return result;
}

describe("runUserContextRead (workers neon-http batch)", () => {
  afterEach(async () => {
    await truncateAll();
  });

  test("throws without an active request frame", async () => {
    await expect(
      runUserContextRead("00000000-0000-0000-0000-000000000000", (db) => [
        db.select({ id: projects.id }).from(projects),
      ]),
    ).rejects.toThrow(/withRequestDb/);
  });

  test("wrong-tenant reads return empty over the HTTP batch path", async () => {
    const teamA = await seedUserOrgProject("http-a");
    const teamB = await seedUserOrgProject("http-b");

    const [own, foreign] = await inRequestFrame(() =>
      runUserContextRead(teamA.userId, (db) => [
        db.select({ id: projects.id }).from(projects),
        db
          .select({ id: projects.id })
          .from(projects)
          .where(sql`${projects.id} = ${teamB.projectId}`),
      ]),
    );

    expect(own.map((r) => r.id)).toEqual([teamA.projectId]);
    expect(foreign).toEqual([]);
  });

  test("prepends set_config and sends one read-only ReadCommitted batch", async () => {
    const fx = await seedUserOrgProject("http-batch");
    const before = shim.requests.length;

    await inRequestFrame(() =>
      runUserContextRead(fx.userId, (db) => [
        db.select({ id: projects.id }).from(projects),
        db.select({ title: projects.title }).from(projects),
      ]),
    );

    expect(shim.requests.length).toBe(before + 1);
    const request = shim.requests[before];
    expect(request.queries).toHaveLength(3);
    expect(request.queries[0].query).toContain("set_config('app.user_id'");
    expect(request.queries[0].params).toEqual([fx.userId]);
    expect(request.headers["Neon-Batch-Read-Only"]).toBe("true");
    expect(request.headers["Neon-Batch-Isolation-Level"]).toBe("ReadCommitted");
  });

  test("sets app.user_id for raw statements inside the batch", async () => {
    const fx = await seedUserOrgProject("http-guc");

    const [gucRows] = await inRequestFrame(() =>
      runUserContextRead(fx.userId, (db) => [
        db.execute(sql`SELECT current_setting('app.user_id', TRUE) AS uid`),
      ]),
    );

    const [row] = normalizeExecuteResult<{ uid: string }>(gucRows);
    expect(row.uid).toBe(fx.userId);
  });

  test("maps drizzle column types through the HTTP result path", async () => {
    const fx = await seedUserOrgProject("http-types");

    const [rows] = await inRequestFrame(() =>
      runUserContextRead(fx.userId, (db) => [
        db
          .select({ id: projects.id, createdAt: projects.createdAt })
          .from(projects),
      ]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fx.projectId);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  test("read-only guard rejects a write before any request is sent", async () => {
    const fx = await seedUserOrgProject("http-guard");
    const before = shim.requests.length;

    await expect(
      inRequestFrame(() =>
        runUserContextRead(fx.userId, (db) => [
          db.execute(sql`UPDATE projects SET title = 'pwned'`),
        ]),
      ),
    ).rejects.toThrow(ReadOnlyViolationError);

    expect(shim.requests.length).toBe(before);
  });

  test("the batch transaction is READ ONLY at the database level", async () => {
    const fx = await seedUserOrgProject("http-db-ro");

    await expect(
      inRequestFrame(() =>
        runUserContextRead(fx.userId, (db) => [
          db.execute(sql`SELECT nextval('rls_read_probe_seq')`),
        ]),
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });
});
