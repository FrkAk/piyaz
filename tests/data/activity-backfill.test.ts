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
      // Legacy data only ever stored actor:"ai" (even for human web actions),
      // so the real actor is unknowable: attribute every legacy row to system
      // rather than fabricating web/agent.
      expect(rows.map((r) => r.source)).toEqual(["system", "system"]);
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

  test("backfills a task already carrying a runtime event, and stays row-idempotent", async () => {
    const fx = await seedUserOrgProject("bf-2");
    const sr = serviceRoleConnect();
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, history)
        VALUES (${fx.projectId}, 'T', 1, ${sr.json([
          {
            id: "leg1",
            type: "created",
            date: "2025-01-01T00:00:00.000Z",
            label: "Task created",
            description: "",
            actor: "ai",
          },
        ])}) RETURNING id`;
      const taskId = t.id;
      // The task was mutated after deploy, so a runtime event already exists.
      // The per-task guard must not let that suppress the legacy backfill.
      await sr`
        INSERT INTO activity_events (project_id, task_id, type, source, summary)
        VALUES (${fx.projectId}, ${taskId}, 'title_changed', 'web', 'live edit')`;

      await sr.unsafe(BACKFILL_SQL);
      const legacy = await sr`
        SELECT source FROM activity_events
        WHERE task_id = ${taskId} AND type = 'task_created'`;
      expect(legacy.length).toBe(1);
      expect(legacy[0].source).toBe("system");

      // Re-running does not duplicate the migrated legacy row.
      await sr.unsafe(BACKFILL_SQL);
      const [{ count }] = await sr<{ count: number }[]>`
        SELECT count(*)::int AS count FROM activity_events
        WHERE task_id = ${taskId} AND type = 'task_created'`;
      expect(count).toBe(1);
    } finally {
      await sr.end({ timeout: 5 });
    }
  });
});
