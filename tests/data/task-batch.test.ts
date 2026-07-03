import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import {
  BatchInputError,
  createTasksBatch,
  DuplicateTaskTitleError,
} from "@/lib/data/task-batch";
import {
  TaskLimitError,
  EdgeCycleError,
  UnknownCategoryError,
} from "@/lib/graph/errors";
import { CrossProjectEdgeError, DuplicateEdgeError } from "@/lib/graph/errors";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

/**
 * Await a promise expected to reject and return the thrown value.
 *
 * @param p - Promise expected to reject.
 * @returns The rejection value.
 * @throws Error when the promise resolves instead of rejecting.
 */
async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected promise to reject");
}

/**
 * Count task rows for a project, bypassing RLS.
 *
 * @param projectId - Owning project id.
 * @returns Row count.
 */
async function countTasks(projectId: string): Promise<number> {
  const [{ count }] = await serviceRoleConnect()<{ count: number }[]>`
    SELECT count(*)::int AS count FROM tasks WHERE project_id = ${projectId}`;
  return count;
}

/**
 * Count activity events for a project by type, bypassing RLS.
 *
 * @param projectId - Owning project id.
 * @param type - Event type.
 * @returns Row count.
 */
async function countActivity(projectId: string, type: string): Promise<number> {
  const [{ count }] = await serviceRoleConnect()<{ count: number }[]>`
    SELECT count(*)::int AS count FROM activity_events
    WHERE project_id = ${projectId} AND type = ${type}`;
  return count;
}

/**
 * Insert a task with a chosen sequence number, bypassing RLS.
 *
 * @param projectId - Owning project id.
 * @param seq - Per-project sequence number.
 * @param title - Task title.
 * @returns Created task id.
 */
async function insertTask(
  projectId: string,
  seq: number,
  title: string,
): Promise<string> {
  const [t] = await superuserPool()<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${projectId}, ${title}, ${seq})
    RETURNING id`;
  return t.id;
}

describe("createTasksBatch", () => {
  test("batch of 3 allocates sequential seq continuing from MAX, order appended", async () => {
    const f = await seedUserOrgProject("b1");
    const ctx = makeAuthContext(f.userId);
    await createTask(ctx, { projectId: f.projectId, title: "existing" });

    const res = await createTasksBatch(ctx, f.projectId, [
      { title: "A" },
      { title: "B" },
      { title: "C" },
    ]);

    expect(res.created.map((c) => c.taskRef)).toEqual([
      "PRJb1-2",
      "PRJb1-3",
      "PRJb1-4",
    ]);
    expect(res.deduped).toEqual([]);
    expect(res.edges).toBe(0);

    const orders = await serviceRoleConnect()<{ order: number }[]>`
      SELECT "order" FROM tasks WHERE project_id = ${f.projectId}
      ORDER BY sequence_number`;
    expect(orders.map((o) => o.order)).toEqual([0, 1, 2, 3]);
  });

  test("exact re-run of the same payload is idempotent end to end", async () => {
    const f = await seedUserOrgProject("b2");
    const ctx = makeAuthContext(f.userId);
    const items = [
      { key: "a", title: "Alpha" },
      { key: "b", title: "Beta" },
    ];
    const edges = [
      {
        source: "a",
        target: "b",
        type: "depends_on" as const,
        note: "a needs b",
      },
    ];

    const first = await createTasksBatch(ctx, f.projectId, items, edges);
    expect(first.created).toHaveLength(2);
    expect(first.edges).toBe(1);

    const createdCount = await countTasks(f.projectId);
    const createdActivity = await countActivity(f.projectId, "task_created");

    const second = await createTasksBatch(ctx, f.projectId, items, edges);
    expect(second.created).toEqual([]);
    expect(second.deduped).toHaveLength(2);
    expect(second.deduped.map((d) => d.id).sort()).toEqual(
      first.created.map((c) => c.id).sort(),
    );
    expect(second.edges).toBe(0);

    expect(await countTasks(f.projectId)).toBe(createdCount);
    expect(await countActivity(f.projectId, "task_created")).toBe(
      createdActivity,
    );
  });

  test("intra-batch duplicate title: skip dedups, error throws", async () => {
    const f = await seedUserOrgProject("b3");
    const ctx = makeAuthContext(f.userId);

    const res = await createTasksBatch(
      ctx,
      f.projectId,
      [
        { key: "x", title: "Same" },
        { key: "y", title: "Same" },
        { key: "z", title: "Other" },
      ],
      // `y` deduped to `x`'s task, yet remains usable as an endpoint.
      [{ source: "y", target: "z", type: "relates_to", note: "n" }],
    );
    expect(res.created).toHaveLength(2);
    expect(res.deduped).toHaveLength(1);
    expect(res.deduped[0].id).toBe(res.created[0].id);
    expect(res.edges).toBe(1);

    const f2 = await seedUserOrgProject("b3b");
    const ctx2 = makeAuthContext(f2.userId);
    const err = await catchErr(
      createTasksBatch(
        ctx2,
        f2.projectId,
        [{ title: "Dup" }, { title: "Dup" }],
        [],
        "error",
      ),
    );
    expect(err).toBeInstanceOf(DuplicateTaskTitleError);
    expect((err as DuplicateTaskTitleError).titles).toContain("Dup");
  });

  test("onDuplicate='error' vs existing title throws, writes nothing", async () => {
    const f = await seedUserOrgProject("b4");
    const ctx = makeAuthContext(f.userId);
    await createTask(ctx, { projectId: f.projectId, title: "Exists" });
    const before = await countTasks(f.projectId);

    const err = await catchErr(
      createTasksBatch(
        ctx,
        f.projectId,
        [{ title: "Exists" }, { title: "Fresh" }],
        [],
        "error",
      ),
    );
    expect(err).toBeInstanceOf(DuplicateTaskTitleError);
    expect((err as DuplicateTaskTitleError).titles).toContain("Exists");
    expect(await countTasks(f.projectId)).toBe(before);
  });

  test("limit check trips before any insert", async () => {
    const f = await seedUserOrgProject("b5");
    const ctx = makeAuthContext(f.userId);
    await createTask(ctx, { projectId: f.projectId, title: "one" });
    await createTask(ctx, { projectId: f.projectId, title: "two" });
    const before = await countTasks(f.projectId);

    const prev = process.env.MAX_TASKS_PER_PROJECT;
    process.env.MAX_TASKS_PER_PROJECT = "3";
    try {
      const err = await catchErr(
        createTasksBatch(ctx, f.projectId, [{ title: "x" }, { title: "y" }]),
      );
      expect(err).toBeInstanceOf(TaskLimitError);
    } finally {
      if (prev === undefined) delete process.env.MAX_TASKS_PER_PROJECT;
      else process.env.MAX_TASKS_PER_PROJECT = prev;
    }
    expect(await countTasks(f.projectId)).toBe(before);
  });

  test("edges via keys and UUID; empty note rejected", async () => {
    const f = await seedUserOrgProject("b6");
    const ctx = makeAuthContext(f.userId);
    const existing = await createTask(ctx, {
      projectId: f.projectId,
      title: "pre",
    });

    const res = await createTasksBatch(
      ctx,
      f.projectId,
      [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
      ],
      [
        { source: "a", target: "b", type: "relates_to", note: "keys" },
        { source: "a", target: existing.id, type: "depends_on", note: "uuid" },
      ],
    );
    expect(res.created).toHaveLength(2);
    expect(res.edges).toBe(2);

    const err = await catchErr(
      createTasksBatch(
        ctx,
        f.projectId,
        [
          { key: "c", title: "C" },
          { key: "d", title: "D" },
        ],
        [{ source: "c", target: "d", type: "relates_to", note: "   " }],
      ),
    );
    expect(err).toBeInstanceOf(BatchInputError);
  });

  test("edge count over the cap is rejected before any write", async () => {
    const f = await seedUserOrgProject("b12");
    const ctx = makeAuthContext(f.userId);
    const uuid = "00000000-0000-4000-8000-000000000000";
    const edges = Array.from({ length: 101 }, () => ({
      source: "a",
      target: uuid,
      type: "relates_to" as const,
      note: "n",
    }));

    const err = await catchErr(
      createTasksBatch(ctx, f.projectId, [{ key: "a", title: "A" }], edges),
    );
    expect(err).toBeInstanceOf(BatchInputError);
    expect(await countTasks(f.projectId)).toBe(0);
  });

  test("batch cycle and cycle through an existing edge throw EdgeCycleError", async () => {
    const f = await seedUserOrgProject("b7");
    const ctx = makeAuthContext(f.userId);

    const err1 = await catchErr(
      createTasksBatch(
        ctx,
        f.projectId,
        [
          { key: "a", title: "A" },
          { key: "b", title: "B" },
        ],
        [
          { source: "a", target: "b", type: "depends_on", note: "n" },
          { source: "b", target: "a", type: "depends_on", note: "n" },
        ],
      ),
    );
    expect(err1).toBeInstanceOf(EdgeCycleError);
    expect(await countTasks(f.projectId)).toBe(0);

    // existing B -> C depends_on; batch adds C -> B closing the cycle.
    const b = await insertTask(f.projectId, 1, "BB");
    const c = await insertTask(f.projectId, 2, "CC");
    await superuserPool()`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
      VALUES (${b}, ${c}, 'depends_on')`;

    const err2 = await catchErr(
      createTasksBatch(
        ctx,
        f.projectId,
        [{ title: "dummy" }],
        [{ source: c, target: b, type: "depends_on", note: "n" }],
      ),
    );
    expect(err2).toBeInstanceOf(EdgeCycleError);
    // dummy task rolled back.
    expect(await countTasks(f.projectId)).toBe(2);
  });

  test("UUID endpoint from another project or unknown is rejected", async () => {
    const f = await seedUserOrgProject("b8");
    const ctx = makeAuthContext(f.userId);
    const [other] = await superuserPool()<{ id: string }[]>`
      INSERT INTO projects ("organization_id", "title", "identifier")
      VALUES (${f.organizationId}, ${"Other"}, ${"OTHR8"})
      RETURNING id`;
    const foreign = await insertTask(other.id, 1, "foreign");

    const errCross = await catchErr(
      createTasksBatch(
        ctx,
        f.projectId,
        [{ key: "a", title: "A" }],
        [{ source: "a", target: foreign, type: "relates_to", note: "n" }],
      ),
    );
    expect(errCross).toBeInstanceOf(CrossProjectEdgeError);

    const unknown = "00000000-0000-4000-8000-000000000000";
    const errUnknown = await catchErr(
      createTasksBatch(
        ctx,
        f.projectId,
        [{ key: "a", title: "A" }],
        [{ source: "a", target: unknown, type: "relates_to", note: "n" }],
      ),
    );
    expect(errUnknown).toBeInstanceOf(ForbiddenError);
  });

  test("activity: exactly N task_created and 2xE edge_added rows", async () => {
    const f = await seedUserOrgProject("b9");
    const ctx = makeAuthContext(f.userId);

    await createTasksBatch(
      ctx,
      f.projectId,
      [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
        { key: "c", title: "C" },
      ],
      [
        { source: "a", target: "b", type: "depends_on", note: "n" },
        { source: "b", target: "c", type: "relates_to", note: "n" },
      ],
    );

    expect(await countActivity(f.projectId, "task_created")).toBe(3);
    expect(await countActivity(f.projectId, "edge_added")).toBe(4);
  });

  test("duplicate edge within the batch throws DuplicateEdgeError", async () => {
    const f = await seedUserOrgProject("b10");
    const ctx = makeAuthContext(f.userId);
    const err = await catchErr(
      createTasksBatch(
        ctx,
        f.projectId,
        [
          { key: "a", title: "A" },
          { key: "b", title: "B" },
        ],
        [
          { source: "a", target: "b", type: "relates_to", note: "n" },
          { source: "a", target: "b", type: "relates_to", note: "n" },
        ],
      ),
    );
    expect(err).toBeInstanceOf(DuplicateEdgeError);
  });

  test("createTask summary shape unchanged", async () => {
    const f = await seedUserOrgProject("b11");
    const ctx = makeAuthContext(f.userId);
    const t = await createTask(ctx, { projectId: f.projectId, title: "T" });
    expect(Object.keys(t).sort()).toEqual([
      "id",
      "order",
      "projectId",
      "sequenceNumber",
      "taskRef",
      "title",
    ]);
    expect(t.title).toBe("T");
    expect(t.projectId).toBe(f.projectId);
    expect(t.order).toBe(0);
    expect(t.sequenceNumber).toBe(1);
    expect(String(t.taskRef)).toBe("PRJb11-1");
  });
});

test("batch rejects a category outside the project vocabulary before any write", async () => {
  const f = await seedUserOrgProject("batch-cat");
  const ctx = makeAuthContext(f.userId);
  const sql = superuserPool();
  await sql`
    UPDATE projects SET categories = ${JSON.stringify(["backend", "mcp"])}::jsonb
    WHERE id = ${f.projectId}`;

  const err = await createTasksBatch(ctx, f.projectId, [
    { title: "A", description: "First task in the batch. Does A." },
    {
      title: "B",
      description: "Second task in the batch. Does B.",
      category: "zzz_invalid",
    },
  ]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnknownCategoryError);

  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM tasks WHERE project_id = ${f.projectId}`;
  expect(Number(rows[0].count)).toBe(0);
});
