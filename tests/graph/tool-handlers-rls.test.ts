import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { fetchAssigneesUnchecked } from "@/lib/data/task";
import { db } from "@/lib/db";
import { withUserContext } from "@/lib/db/rls";

/**
 * Regression coverage for the bare-call bug class around
 * `fetchAssigneesUnchecked`. Under `app_user` (the production role)
 * without an `app.user_id` GUC frame, the read returns `[]` silently —
 * historically this made a prior-assignee diff flag every assignee as
 * "added", producing wrong activity_events and broken
 * completion-protocol hints.
 *
 * Test 1 pins the safe shape: when the call sits inside a
 * `withUserContext` frame the assignees come back.
 *
 * Test 2 locks in the bug class: without a GUC frame under `app_user`,
 * `fetchAssigneesUnchecked` returns empty. If a future regression
 * reintroduces a bare call (today's callers live in `lib/data/task-edit.ts`
 * and the assignee primitives), this test still passes for the unsafe
 * shape, but only GUC-framed calls produce a correct list.
 */

afterEach(async () => {
  await truncateAll();
});

describe("fetchAssigneesUnchecked behavior under app_user", () => {
  test("returns the existing assignees when called inside a withUserContext frame", async () => {
    const fx = await seedUserOrgProject("toolhandler-assignees");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, status)
        VALUES (${fx.projectId}, 'With assignee', 1, 'planned')
        RETURNING id`;
      await sr`INSERT INTO task_assignees (task_id, user_id)
               VALUES (${t.id}, ${fx.userId})`;
      taskId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const result = await withUserContext(fx.userId, (tx) =>
      fetchAssigneesUnchecked(taskId, tx),
    );
    expect(result.length).toBe(1);
    expect(result[0].userId).toBe(fx.userId);
  });

  test("returns empty when called WITHOUT a withUserContext frame under app_user", async () => {
    const fx = await seedUserOrgProject("toolhandler-assignees-bare");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, status)
        VALUES (${fx.projectId}, 'With assignee', 1, 'planned')
        RETURNING id`;
      await sr`INSERT INTO task_assignees (task_id, user_id)
               VALUES (${t.id}, ${fx.userId})`;
      taskId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const result = await fetchAssigneesUnchecked(taskId, db);
    expect(result.length).toBe(0);
  });
});
