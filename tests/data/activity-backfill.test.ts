import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";

afterEach(async () => {
  await truncateAll();
});

const BACKFILL_SQL = readFileSync(
  "scripts/backfill-activity-events.sql",
  "utf8",
);

describe("activity backfill SQL", () => {
  test("maps legacy JSONB entries to event rows and is idempotent", async () => {
    const fx = await seedUserOrgProject("bf-1");
    const sr = serviceRoleConnect();
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, history)
        VALUES (${fx.projectId}, 'T', 1, ${sr.json([
          {
            id: "h1",
            type: "created",
            date: "2025-01-01T00:00:00.000Z",
            label: "Task created",
            description: "",
            actor: "ai",
          },
          {
            id: "h2",
            type: "status_change",
            date: "2025-01-02T00:00:00.000Z",
            label: "Status: draft → done",
            description: "",
            actor: "user",
          },
        ])}) RETURNING id`;
      const taskId = t.id;

      await sr.unsafe(BACKFILL_SQL);
      const rows = await sr`
        SELECT type, source, actor_user_id FROM activity_events
        WHERE task_id = ${taskId} ORDER BY created_at`;
      expect(rows.map((r) => r.type)).toEqual([
        "task_created",
        "status_changed",
      ]);
      expect(rows.map((r) => r.source)).toEqual(["mcp", "web"]);
      expect(rows.every((r) => r.actor_user_id === null)).toBe(true);

      // Idempotent: a second run inserts nothing.
      await sr.unsafe(BACKFILL_SQL);
      const [{ count }] = await sr<{ count: number }[]>`
        SELECT count(*)::int AS count FROM activity_events WHERE task_id = ${taskId}`;
      expect(count).toBe(2);
    } finally {
      await sr.end({ timeout: 5 });
    }
  });
});
