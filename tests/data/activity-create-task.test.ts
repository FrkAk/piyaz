import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";

afterEach(async () => {
  await truncateAll();
});

describe("createTask activity", () => {
  test("records a task_created event attributed to the actor", async () => {
    const fx = await seedUserOrgProject("ct-1");
    const ctx = makeAuthContext(fx.userId, {
      source: "mcp",
      userId: fx.userId,
      clientId: null,
    });
    const task = await createTask(ctx, {
      projectId: fx.projectId,
      title: "First",
    } as Parameters<typeof createTask>[1]);

    const sr = serviceRoleConnect();
    try {
      const rows = await sr`
        SELECT type, source FROM activity_events WHERE task_id = ${task.id}`;
      expect(rows.length).toBe(1);
      expect(rows[0].type).toBe("task_created");
      expect(rows[0].source).toBe("mcp");
    } finally {
      await sr.end({ timeout: 5 });
    }
  });
});
