import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { withUserContext } from "@/lib/db/rls";
import { insertActivityEvents } from "@/lib/data/activity";

afterEach(async () => {
  await truncateAll();
});

describe("insertActivityEvents", () => {
  test("writes rows under the caller's transaction", async () => {
    const fx = await seedUserOrgProject("ins-1");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    await withUserContext(fx.userId, async (tx) => {
      await insertActivityEvents(tx, { source: "web", userId: fx.userId }, [
        {
          projectId: fx.projectId,
          taskId,
          type: "status_changed",
          summary: "moved to done",
          metadata: { from: "draft", to: "done" },
        },
      ]);
    });

    const sr2 = serviceRoleConnect();
    try {
      const rows = await sr2`
        SELECT type, summary, actor_user_id, source, metadata
        FROM activity_events WHERE task_id = ${taskId}`;
      expect(rows.length).toBe(1);
      expect(rows[0].type).toBe("status_changed");
      expect(rows[0].actor_user_id).toBe(fx.userId);
      expect(rows[0].source).toBe("web");
      expect(rows[0].metadata).toEqual({ from: "draft", to: "done" });
    } finally {
      await sr2.end({ timeout: 5 });
    }
  });
});
