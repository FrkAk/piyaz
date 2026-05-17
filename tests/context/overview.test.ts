import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import {
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { buildProjectOverview } from "@/lib/context/_core/overview";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

describe("buildProjectOverview under app_user", () => {
  test("returns task list, assignees, and edges for an authorized caller", async () => {
    const fx = await seedUserOrgProject("overview-ctx-1");
    const sr = serviceRoleConnect();
    try {
      const [a] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'A', 1)
        RETURNING id`;
      const [b] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'B', 2)
        RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${b.id}, ${a.id}, 'depends_on')`;
      await sr`INSERT INTO task_assignees (task_id, user_id)
               VALUES (${a.id}, ${fx.userId})`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildProjectOverview(ctx, fx.projectId);
    expect(result.totalTasks).toBe(2);
    expect(result.tasks.map((t) => t.title).sort()).toEqual(["A", "B"]);
    const taskA = result.tasks.find((t) => t.title === "A");
    expect(taskA?.assigneeCount).toBe(1);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].edgeType).toBe("depends_on");
  });

  test("rejects cross-team callers (RLS isolation under app_user)", async () => {
    const fxA = await seedUserOrgProject("overview-ctx-a");
    const fxB = await seedUserOrgProject("overview-ctx-b");
    const sr = serviceRoleConnect();
    try {
      await sr`INSERT INTO tasks (project_id, title, sequence_number)
               VALUES (${fxA.projectId}, 'A-task', 1)`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fxB.userId);
    await expect(buildProjectOverview(ctx, fxA.projectId)).rejects.toThrow(
      ForbiddenError,
    );
  });
});
