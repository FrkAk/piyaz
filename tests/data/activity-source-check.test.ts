import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";

afterEach(async () => {
  await truncateAll();
});

describe("activity_events source constraint", () => {
  test("rejects an out-of-domain source value", async () => {
    const fx = await seedUserOrgProject("src-check");
    const su = superuserPool();
    const [t] = await su<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number)
      VALUES (${fx.projectId}, 'T', 1) RETURNING id`;

    let rejected = false;
    try {
      await su`
        INSERT INTO activity_events
          (project_id, task_id, type, source, summary)
        VALUES (${fx.projectId}, ${t.id}, 'title_changed', 'bogus', 'x')`;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("accepts the three valid sources", async () => {
    const fx = await seedUserOrgProject("src-ok");
    const su = superuserPool();
    try {
      const [t] = await su<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      for (const source of ["web", "mcp", "system"]) {
        await su`
          INSERT INTO activity_events
            (project_id, task_id, type, source, summary)
          VALUES (${fx.projectId}, ${t.id}, 'title_changed', ${source}, 'x')`;
      }
      const [{ count }] = await su<{ count: number }[]>`
        SELECT count(*)::int AS count FROM activity_events WHERE task_id = ${t.id}`;
      expect(count).toBe(3);
    } finally {
      await su.end({ timeout: 5 });
    }
  });
});
