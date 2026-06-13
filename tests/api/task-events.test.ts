import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { listTaskActivity } from "@/lib/data/activity";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

// Endpoint wiring is thin; assert the data function it delegates to returns a
// shaped page (the route adds only auth + JSON serialization).
describe("task activity endpoint contract", () => {
  test("listTaskActivity returns events + nextCursor shape", async () => {
    const fx = await seedUserOrgProject("ep-1");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
      await sr`
        INSERT INTO activity_events (project_id, task_id, type, source, summary)
        VALUES (${fx.projectId}, ${taskId}, 'title_changed', 'web', 'x')`;
    } finally {
      await sr.end({ timeout: 5 });
    }
    const page = await listTaskActivity(makeAuthContext(fx.userId), taskId, {});
    expect(page).toHaveProperty("events");
    expect(page).toHaveProperty("nextCursor");
    expect(page.events[0]?.summary).toBe("x");
  });
});
