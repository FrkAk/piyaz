import { afterEach, expect, setSystemTime, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { createEdge, updateEdge } from "@/lib/data/edge";
import { updateProject } from "@/lib/data/project";

/**
 * Concurrency pins for the clock-source unification: a write that waited
 * on a lock, or that commits from a transaction opened before another
 * write already committed, must still stamp above every stamp committed
 * meanwhile. `clock_timestamp()` provides this (row-write wall time,
 * re-evaluated after the lock wait under READ COMMITTED); `now()` or a
 * JS `new Date()` stamp computed before the wait would land below the
 * held stamp and freeze the validator. The app clock is frozen an hour
 * in the past around each writer dispatch so an app-clock stamp cannot
 * pass by accident.
 */

const APP_CLOCK_LAG_MS = 3_600_000;

afterEach(async () => {
  setSystemTime();
  await truncateAll();
});

test("a FOR UPDATE writer blocked behind a concurrent stamp lands above it", async () => {
  const f = await seedUserOrgProject("clockrace-edge");
  const ctx = makeAuthContext(f.userId);
  const a = await createTask(ctx, { projectId: f.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: f.projectId, title: "B" });
  const edge = await createEdge(ctx, {
    sourceTaskId: a.id,
    targetTaskId: b.id,
    edgeType: "relates_to",
  });

  const su = superuserPool();
  let blocked: Promise<unknown> = Promise.resolve();
  let heldEpoch = 0;
  try {
    await su.begin(async (t1) => {
      const [held] = await t1<{ u: number }[]>`
        UPDATE task_edges
        SET note = 'held', updated_at = clock_timestamp()
        WHERE id = ${edge.id}
        RETURNING extract(epoch FROM updated_at)::float8 AS u
      `;
      heldEpoch = held.u;
      await new Promise((r) => setTimeout(r, 30));
      setSystemTime(new Date(Date.now() - APP_CLOCK_LAG_MS));
      blocked = updateEdge(ctx, edge.id, { note: "after the wait" });
      await new Promise((r) => setTimeout(r, 250));
    });
    await blocked;
    setSystemTime();

    const [after] = await su<{ u: number }[]>`
      SELECT extract(epoch FROM updated_at)::float8 AS u
      FROM task_edges WHERE id = ${edge.id}
    `;
    expect(after.u).toBeGreaterThan(heldEpoch);
  } finally {
    setSystemTime();
    await su.end({ timeout: 5 });
  }
});

test("a direct UPDATE blocked on the projects row re-evaluates its stamp after the wait", async () => {
  const f = await seedUserOrgProject("clockrace-proj");
  const ctx = makeAuthContext(f.userId);

  const su = superuserPool();
  let blocked: Promise<unknown> = Promise.resolve();
  let heldEpoch = 0;
  try {
    await su.begin(async (t1) => {
      const [held] = await t1<{ u: number }[]>`
        UPDATE projects
        SET updated_at = clock_timestamp(),
            meta_updated_at = clock_timestamp()
        WHERE id = ${f.projectId}
        RETURNING extract(epoch FROM updated_at)::float8 AS u
      `;
      heldEpoch = held.u;
      await new Promise((r) => setTimeout(r, 30));
      setSystemTime(new Date(Date.now() - APP_CLOCK_LAG_MS));
      blocked = updateProject(ctx, f.projectId, { title: "After the wait" });
      await new Promise((r) => setTimeout(r, 250));
    });
    await blocked;
    setSystemTime();

    const [after] = await su<{ u: number; m: number }[]>`
      SELECT extract(epoch FROM updated_at)::float8 AS u,
             extract(epoch FROM meta_updated_at)::float8 AS m
      FROM projects WHERE id = ${f.projectId}
    `;
    expect(after.u).toBeGreaterThan(heldEpoch);
    expect(after.m).toBeGreaterThan(heldEpoch);
  } finally {
    setSystemTime();
    await su.end({ timeout: 5 });
  }
});

test("a task delete from a long-open transaction still moves the project clocks", async () => {
  const f = await seedUserOrgProject("clockrace-del");
  const ctx = makeAuthContext(f.userId);
  const a = await createTask(ctx, { projectId: f.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: f.projectId, title: "B" });

  const su = superuserPool();
  let concurrentEpoch = 0;
  try {
    await su.begin(async (t1) => {
      await t1`SELECT now()`;
      await new Promise((r) => setTimeout(r, 20));
      const [stamped] = await su<{ u: number }[]>`
        UPDATE tasks SET updated_at = clock_timestamp()
        WHERE id = ${b.id}
        RETURNING extract(epoch FROM updated_at)::float8 AS u
      `;
      concurrentEpoch = stamped.u;
      await new Promise((r) => setTimeout(r, 20));
      await t1`DELETE FROM tasks WHERE id = ${a.id}`;
    });

    const [project] = await su<{ u: number; m: number }[]>`
      SELECT extract(epoch FROM updated_at)::float8 AS u,
             extract(epoch FROM meta_updated_at)::float8 AS m
      FROM projects WHERE id = ${f.projectId}
    `;
    expect(project.u).toBeGreaterThan(concurrentEpoch);
    expect(project.m).toBeGreaterThan(concurrentEpoch);
  } finally {
    await su.end({ timeout: 5 });
  }
});

test("an insert from a long-open transaction lands above stamps committed meanwhile", async () => {
  const f = await seedUserOrgProject("clockrace-ins");

  const su = superuserPool();
  let concurrentEpoch = 0;
  try {
    await su.begin(async (t1) => {
      await t1`SELECT now()`;
      await new Promise((r) => setTimeout(r, 20));
      const [stamped] = await su<{ u: number }[]>`
        UPDATE projects SET updated_at = clock_timestamp()
        WHERE id = ${f.projectId}
        RETURNING extract(epoch FROM updated_at)::float8 AS u
      `;
      concurrentEpoch = stamped.u;
      await new Promise((r) => setTimeout(r, 20));
      const [inserted] = await t1<{ u: number; m: number }[]>`
        INSERT INTO notes ("project_id", "title", "slug")
        VALUES (${f.projectId}, 'Late insert', 'late-insert')
        RETURNING extract(epoch FROM updated_at)::float8 AS u,
                  extract(epoch FROM meta_updated_at)::float8 AS m
      `;
      expect(inserted.u).toBeGreaterThan(concurrentEpoch);
      expect(inserted.m).toBeGreaterThan(concurrentEpoch);
    });
  } finally {
    await su.end({ timeout: 5 });
  }
});
