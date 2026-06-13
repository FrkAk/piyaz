import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask, updateTask } from "@/lib/data/task";

afterEach(async () => {
  await truncateAll();
});

describe("updateTask activity", () => {
  test("emits one event per changed field", async () => {
    const fx = await seedUserOrgProject("ut-1");
    const ctx = makeAuthContext(fx.userId, {
      source: "web",
      userId: fx.userId,
    });
    const task = await createTask(ctx, {
      projectId: fx.projectId,
      title: "Old",
    } as Parameters<typeof createTask>[1]);

    await updateTask(ctx, task.id, { title: "New", status: "in_progress" });

    const sr = serviceRoleConnect();
    try {
      const rows = await sr`
        SELECT type FROM activity_events
        WHERE task_id = ${task.id} AND type <> 'task_created'
        ORDER BY type`;
      expect(rows.map((r) => r.type)).toEqual([
        "status_changed",
        "title_changed",
      ]);
    } finally {
      await sr.end({ timeout: 5 });
    }
  });
});
