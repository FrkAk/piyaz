import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";
import { listProjectActivity, listTaskActivity } from "@/lib/data/activity";

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
    // Assert the exact seeded name (not just non-null) so a wrong-column /
    // wrong-row SDF join can't pass by returning some other string.
    expect(page.events[0].actorName).toBe("User list-hydrate");
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
    await expect(
      listTaskActivity(ctx, taskId, { limit: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("since returns only events newer than the bound", async () => {
    const fx = await seedUserOrgProject("list-task-since");
    const sr = serviceRoleConnect();
    let taskId: string;
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      taskId = t.id;
      for (let i = 0; i < 4; i++) {
        await sr`
          INSERT INTO activity_events
            (project_id, task_id, type, source, summary, created_at)
          VALUES (${fx.projectId}, ${taskId}, 'title_changed', 'web',
                  ${"e" + i}, ${new Date(base + i * 1000)})`;
      }
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const since = new Date(base + 1 * 1000).toISOString();
    const page = await listTaskActivity(ctx, taskId, { limit: 10, since });
    expect(page.events.map((e) => e.summary)).toEqual(["e3", "e2"]);
  });
});

describe("listProjectActivity", () => {
  test("returns newest-first and paginates by cursor", async () => {
    const fx = await seedUserOrgProject("proj-list-1");
    const sr = serviceRoleConnect();
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'T', 1) RETURNING id`;
      for (let i = 0; i < 5; i++) {
        await sr`
          INSERT INTO activity_events
            (project_id, task_id, type, source, summary, created_at)
          VALUES (${fx.projectId}, ${t.id}, 'title_changed', 'web',
                  ${"e" + i}, now() + (${i} || ' seconds')::interval)`;
      }
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const page1 = await listProjectActivity(ctx, fx.projectId, { limit: 3 });
    expect(page1.events.map((e) => e.summary)).toEqual(["e4", "e3", "e2"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listProjectActivity(ctx, fx.projectId, {
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.events.map((e) => e.summary)).toEqual(["e1", "e0"]);
    expect(page2.nextCursor).toBeNull();
  });

  test("includes project-level events with a null task_id", async () => {
    const fx = await seedUserOrgProject("proj-list-null");
    const sr = serviceRoleConnect();
    try {
      await sr`
        INSERT INTO activity_events (project_id, task_id, type, source, summary)
        VALUES (${fx.projectId}, NULL, 'project_created', 'web', 'created')`;
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(fx.userId);
    const page = await listProjectActivity(ctx, fx.projectId, { limit: 10 });
    expect(page.events.map((e) => e.summary)).toEqual(["created"]);
    expect(page.events[0].taskId).toBeNull();
  });

  test("since returns only events newer than the bound", async () => {
    const fx = await seedUserOrgProject("proj-list-since");
    const sr = serviceRoleConnect();
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    try {
      for (let i = 0; i < 4; i++) {
        await sr`
          INSERT INTO activity_events (project_id, task_id, type, source, summary, created_at)
          VALUES (${fx.projectId}, NULL, 'project_created', 'web',
                  ${"e" + i}, ${new Date(base + i * 1000)})`;
      }
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(fx.userId);
    const since = new Date(base + 1 * 1000).toISOString();
    const page = await listProjectActivity(ctx, fx.projectId, {
      limit: 10,
      since,
    });
    expect(page.events.map((e) => e.summary)).toEqual(["e3", "e2"]);
  });

  test("a non-member gets a 404-shaped error, not an empty feed", async () => {
    const owner = await seedUserOrgProject("proj-list-owner");
    const stranger = await seedUserOrgProject("proj-list-stranger");
    const sr = serviceRoleConnect();
    try {
      await sr`
        INSERT INTO activity_events (project_id, task_id, type, source, summary)
        VALUES (${owner.projectId}, NULL, 'project_created', 'web', 'secret')`;
    } finally {
      await sr.end({ timeout: 5 });
    }
    const ctx = makeAuthContext(stranger.userId);
    await expect(
      listProjectActivity(ctx, owner.projectId, { limit: 10 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
