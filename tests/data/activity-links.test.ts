import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import {
  createTask,
  updateTask,
  addTaskLink,
  removeTaskLink,
  updateTaskLink,
} from "@/lib/data/task";

afterEach(async () => {
  await truncateAll();
});

/** The link-kind activity events on a task, oldest-first. */
async function linkEvents(taskId: string): Promise<string[]> {
  const sr = serviceRoleConnect();
  try {
    const rows = await sr<{ type: string }[]>`
      SELECT type FROM activity_events
      WHERE task_id = ${taskId} AND type LIKE 'link_%'
      ORDER BY created_at, type`;
    return rows.map((r) => r.type);
  } finally {
    await sr.end({ timeout: 5 });
  }
}

describe("link mutation activity", () => {
  test("addTaskLink writes one link_added event", async () => {
    const fx = await seedUserOrgProject("act-link-add");
    const ctx = makeAuthContext(fx.userId);
    const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });

    await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");

    expect(await linkEvents(task.id)).toEqual(["link_added"]);
  });

  test("addTaskLink writes no event when the link already exists", async () => {
    const fx = await seedUserOrgProject("act-link-dup");
    const ctx = makeAuthContext(fx.userId);
    const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });

    await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");
    await addTaskLink(ctx, task.id, "https://github.com/o/r/pull/1");

    expect(await linkEvents(task.id)).toEqual(["link_added"]);
  });

  test("removeTaskLink writes one link_removed event", async () => {
    const fx = await seedUserOrgProject("act-link-rm");
    const ctx = makeAuthContext(fx.userId);
    const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });
    const link = await addTaskLink(
      ctx,
      task.id,
      "https://github.com/o/r/pull/1",
    );

    await removeTaskLink(ctx, link.id);

    expect(await linkEvents(task.id)).toEqual(["link_added", "link_removed"]);
  });

  test("updateTaskLink writes one link_updated event", async () => {
    const fx = await seedUserOrgProject("act-link-upd");
    const ctx = makeAuthContext(fx.userId);
    const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });
    const link = await addTaskLink(
      ctx,
      task.id,
      "https://github.com/o/r/pull/1",
    );

    await updateTaskLink(ctx, link.id, "github.com/o/r/issues/2");

    expect(await linkEvents(task.id)).toEqual(["link_added", "link_updated"]);
  });

  test("re-submitting the same prUrl does not duplicate link_added", async () => {
    const fx = await seedUserOrgProject("act-link-retry");
    const ctx = makeAuthContext(fx.userId);
    const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });
    const pr = "https://github.com/o/r/pull/7";

    await updateTask(ctx, task.id, { prUrl: pr });
    await updateTask(ctx, task.id, { prUrl: pr });

    expect(await linkEvents(task.id)).toEqual(["link_added"]);
  });

  test("clearing a prUrl that was never set writes no link_removed", async () => {
    const fx = await seedUserOrgProject("act-link-clear");
    const ctx = makeAuthContext(fx.userId);
    const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });

    await updateTask(ctx, task.id, { prUrl: null });

    expect(await linkEvents(task.id)).toEqual([]);
  });
});
