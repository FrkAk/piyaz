import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { listTaskActivity } from "@/lib/data/activity";

afterEach(async () => {
  await truncateAll();
});

describe("listTaskActivity cursor precision", () => {
  test("paginates a same-microsecond cluster without dropping rows", async () => {
    const fx = await seedUserOrgProject("cursor-prec");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
      // Six events sharing ONE microsecond timestamp, as every row written in a
      // single transaction does (now() is constant per tx). The sub-millisecond
      // digits (.123456) are what a millisecond-truncating cursor loses.
      for (let i = 0; i < 6; i++) {
        await sr`
          INSERT INTO activity_events
            (project_id, task_id, type, source, summary, created_at)
          VALUES (${fx.projectId}, ${taskId}, 'title_changed', 'web',
                  ${"e" + i}, '2026-01-01T00:00:00.123456Z'::timestamptz)`;
      }
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listTaskActivity(ctx, taskId, { limit: 2, cursor });
      seen.push(...page.events.map((e) => e.summary));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen.sort()).toEqual(["e0", "e1", "e2", "e3", "e4", "e5"]);
  });

  test("treats a non-UUID cursor id as the first page instead of erroring", async () => {
    const fx = await seedUserOrgProject("cursor-bad");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
      await sr`
        INSERT INTO activity_events (project_id, task_id, type, source, summary)
        VALUES (${fx.projectId}, ${taskId}, 'title_changed', 'web', 'only')`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const bad = Buffer.from("2026-01-01T00:00:00.000Z|not-a-uuid").toString(
      "base64url",
    );
    const page = await listTaskActivity(ctx, taskId, { cursor: bad });
    expect(page.events.map((e) => e.summary)).toEqual(["only"]);
  });
});
