import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { listTaskActivity } from "@/lib/data/activity";

afterEach(async () => {
  await truncateAll();
});

describe("listTaskActivity", () => {
  test("returns newest-first and paginates by cursor", async () => {
    const fx = await seedUserOrgProject("list-1");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
      for (let i = 0; i < 5; i++) {
        await sr`
          INSERT INTO activity_events
            (project_id, task_id, type, source, summary, created_at)
          VALUES (${fx.projectId}, ${taskId}, 'title_changed', 'web',
                  ${"e" + i}, now() + (${i} || ' seconds')::interval)`;
      }
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const page1 = await listTaskActivity(ctx, taskId, { limit: 3 });
    expect(page1.events.map((e) => e.summary)).toEqual(["e4", "e3", "e2"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listTaskActivity(ctx, taskId, {
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.events.map((e) => e.summary)).toEqual(["e1", "e0"]);
    expect(page2.nextCursor).toBeNull();
  });

  test("hydrates actor name at read time via the SDF", async () => {
    const fx = await seedUserOrgProject("list-hydrate");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
      await sr`
        INSERT INTO activity_events
          (project_id, task_id, type, source, actor_user_id, summary)
        VALUES (${fx.projectId}, ${taskId}, 'title_changed', 'web',
                ${fx.userId}, 'x')`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const page = await listTaskActivity(makeAuthContext(fx.userId), taskId, {});
    expect(page.events[0].actorUserId).toBe(fx.userId);
    expect(typeof page.events[0].actorName).toBe("string");
    expect(page.events[0].actorName).not.toBeNull();
  });

  test("a non-member cannot read another project's events", async () => {
    const owner = await seedUserOrgProject("list-owner");
    const stranger = await seedUserOrgProject("list-stranger");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${owner.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
      await sr`
        INSERT INTO activity_events (project_id, task_id, type, source, summary)
        VALUES (${owner.projectId}, ${taskId}, 'title_changed', 'web', 'secret')`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(stranger.userId);
    const page = await listTaskActivity(ctx, taskId, { limit: 10 });
    expect(page.events).toEqual([]);
  });
});
