import { test, expect, describe, beforeAll, afterEach } from "bun:test";
import { sql } from "drizzle-orm";
import { normalizeExecuteResult, executeRaw } from "@/lib/db/raw";
import { aggregateProjectTags } from "@/lib/db/raw/aggregate-project-tags";
import { db } from "@/lib/db";
import { withUserContext } from "@/lib/db/rls";
import { superuserPool } from "@/tests/setup/global";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";

test("normalizeExecuteResult passes postgres-js RowList through", () => {
  const rowList = [{ id: "a" }, { id: "b" }];
  Object.assign(rowList, { count: 2, command: "SELECT" });
  const out = normalizeExecuteResult<{ id: string }>(rowList);
  expect(out).toEqual([{ id: "a" }, { id: "b" }]);
});

test("normalizeExecuteResult unwraps neon QueryResult.rows", () => {
  const queryResult = {
    rows: [{ id: "a" }, { id: "b" }],
    rowCount: 2,
    command: "SELECT",
    fields: [],
  };
  const out = normalizeExecuteResult<{ id: string }>(queryResult);
  expect(out).toEqual([{ id: "a" }, { id: "b" }]);
});

test("normalizeExecuteResult throws on unrecognized shape", () => {
  expect(() => normalizeExecuteResult({ foo: "bar" })).toThrow(
    /unrecognized/i,
  );
});

test("sql template tag still works (sanity)", () => {
  const q = sql`SELECT 1`;
  expect(q).toBeDefined();
});

describe("executeRaw integration (postgres-js driver)", () => {
  beforeAll(() => {
    // setup() already ran in preload.ts; nothing to do here
  });

  afterEach(async () => {
    await truncateAll();
  });

  test("executeRaw returns rows for a simple SELECT", async () => {
    const rows = await executeRaw<{ n: number }>(db, sql`SELECT 1::int AS n`);
    expect(rows).toEqual([{ n: 1 }]);
  });

  test("aggregateProjectTags returns sorted distinct counts", async () => {
    const f = await seedUserOrgProject("rawtest");
    const sqlc = superuserPool();
    try {
      await sqlc`
        INSERT INTO tasks ("project_id", "title", "sequence_number", "tags")
        VALUES
          (${f.projectId}, 'A', 1, '["alpha","beta"]'::jsonb),
          (${f.projectId}, 'B', 2, '["alpha"]'::jsonb)
      `;
    } finally {
      await sqlc.end({ timeout: 5 });
    }

    const rows = await withUserContext(f.userId, (tx) =>
      aggregateProjectTags(tx, f.projectId),
    );

    expect(rows).toEqual([
      { tag: "alpha", count: 2 },
      { tag: "beta", count: 1 },
    ]);
  });
});
