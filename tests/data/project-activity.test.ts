import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { createTask, updateTask, deleteTask } from "@/lib/data/task";
import { createEdge } from "@/lib/data/edge";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

/**
 * Read a project's `updated_at` as epoch seconds with microsecond
 * precision, bypassing RLS via the superuser pool.
 *
 * @param projectId - UUID of the project.
 * @returns Epoch seconds of `projects.updated_at`.
 */
async function projectUpdatedAtEpoch(projectId: string): Promise<number> {
  const sql = superuserPool();
  const [row] = await sql<{ epoch: number }[]>`
    SELECT extract(epoch FROM updated_at)::float8 AS epoch
    FROM projects
    WHERE id = ${projectId}
  `;
  return row.epoch;
}

test("createTask bumps the parent project's updated_at", async () => {
  const f = await seedUserOrgProject("touchcreate");
  const ctx = makeAuthContext(f.userId);
  const before = await projectUpdatedAtEpoch(f.projectId);

  await createTask(ctx, { projectId: f.projectId, title: "T" });

  const after = await projectUpdatedAtEpoch(f.projectId);
  expect(after).toBeGreaterThan(before);
});

test("updateTask bumps the parent project's updated_at", async () => {
  const f = await seedUserOrgProject("touchupdate");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const before = await projectUpdatedAtEpoch(f.projectId);

  await updateTask(ctx, task.id, { description: "changed" });

  const after = await projectUpdatedAtEpoch(f.projectId);
  expect(after).toBeGreaterThan(before);
});

test("createEdge bumps the parent project's updated_at", async () => {
  const f = await seedUserOrgProject("touchedge");
  const ctx = makeAuthContext(f.userId);
  const a = await createTask(ctx, { projectId: f.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: f.projectId, title: "B" });
  const before = await projectUpdatedAtEpoch(f.projectId);

  await createEdge(ctx, {
    sourceTaskId: a.id,
    targetTaskId: b.id,
    edgeType: "depends_on",
  });

  const after = await projectUpdatedAtEpoch(f.projectId);
  expect(after).toBeGreaterThan(before);
});

test("deleteTask bumps the parent project's updated_at", async () => {
  const f = await seedUserOrgProject("touchdelete");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const before = await projectUpdatedAtEpoch(f.projectId);

  await deleteTask(ctx, task.id);

  const after = await projectUpdatedAtEpoch(f.projectId);
  expect(after).toBeGreaterThan(before);
});
