import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask, normalizeContextGolden } from "./fixtures";
import { buildSummaryContext } from "@/lib/context/_core/summary";
import { formatSummary } from "@/lib/graph/format-responses";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

describe("buildSummaryContext under app_user", () => {
  test("returns populated summary for an authorized caller", async () => {
    const fx = await seedUserOrgProject("summary-ctx-1");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [main] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description, status)
        VALUES (${fx.projectId}, 'Main task', 1, 'desc body', 'in_progress')
        RETURNING id`;
      const [other] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, status)
        VALUES (${fx.projectId}, 'Other task', 2, 'todo')
        RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
               VALUES (${main.id}, ${other.id}, 'depends_on', 'edge note')`;
      taskId = main.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildSummaryContext(ctx, taskId);

    expect(result.node.title).toBe("Main task");
    expect(result.node.description).toBe("desc body");
    expect(result.parent?.title).toBeDefined();
    expect(result.edgeCount.depends_on).toBe(1);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].connectedTaskTitle).toBe("Other task");
  });

  test("golden: fully-populated task renders byte-identical summary (has plan)", async () => {
    const fx = await seedRichContextTask("summary-ctx-golden");
    const ctx = makeAuthContext(fx.userId);
    const result = formatSummary(await buildSummaryContext(ctx, fx.taskId));
    expect(result).toContain("has plan");
    expect(
      normalizeContextGolden(result, "summary-ctx-golden"),
    ).toMatchSnapshot();
  });

  test("rejects cross-team callers (RLS isolation under app_user)", async () => {
    const fxA = await seedUserOrgProject("summary-ctx-a");
    const fxB = await seedUserOrgProject("summary-ctx-b");
    const sr = serviceRoleConnect();
    let taskInAId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxA.projectId}, 'In team A', 1)
        RETURNING id`;
      taskInAId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fxB.userId);
    await expect(buildSummaryContext(ctx, taskInAId)).rejects.toThrow(
      ForbiddenError,
    );
  });
});
