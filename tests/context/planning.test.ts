import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { buildPlanningContext } from "@/lib/context/_core/planning";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

describe("buildPlanningContext under app_user", () => {
  test("returns populated dependencies for an authorized caller", async () => {
    const fx = await seedUserOrgProject("planning-ctx-1");
    const sr = serviceRoleConnect();
    let childTaskId: string;
    try {
      const [parent] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description)
        VALUES (${fx.projectId}, 'Parent task', 1, 'Has dependencies')
        RETURNING id`;
      const [child] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description)
        VALUES (${fx.projectId}, 'Child task', 2, 'depends on parent')
        RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${child.id}, ${parent.id}, 'depends_on')`;
      childTaskId = child.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildPlanningContext(ctx, childTaskId);
    expect(result).not.toBeNull();
    expect(result).toContain("Parent task");
  });

  test("cancelled middle is transparent: C surfaces, B does not", async () => {
    // A depends_on B(cancelled) depends_on C(active). The planning bundle
    // for A must show C as a prerequisite and never list B.
    const fx = await seedUserOrgProject("planning-ctx-cancel");
    const sr = serviceRoleConnect();
    let aTaskId: string;
    try {
      const [a] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description)
        VALUES (${fx.projectId}, 'Source task A', 1, 'root')
        RETURNING id`;
      const [b] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description, status)
        VALUES (${fx.projectId}, 'Cancelled middle B', 2, 'skipped', 'cancelled')
        RETURNING id`;
      const [c] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description)
        VALUES (${fx.projectId}, 'Active wall C', 3, 'the real blocker')
        RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${a.id}, ${b.id}, 'depends_on')`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${b.id}, ${c.id}, 'depends_on')`;
      aTaskId = a.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildPlanningContext(ctx, aTaskId);
    expect(result).toContain("Active wall C");
    expect(result).not.toContain("Cancelled middle B");
  });

  test("rejects cross-team callers (RLS isolation under app_user)", async () => {
    const fxA = await seedUserOrgProject("planning-ctx-a");
    const fxB = await seedUserOrgProject("planning-ctx-b");
    const sr = serviceRoleConnect();
    let taskInA: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description)
        VALUES (${fxA.projectId}, 'A task', 1, 'in team A')
        RETURNING id`;
      taskInA = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fxB.userId);
    await expect(buildPlanningContext(ctx, taskInA)).rejects.toThrow(
      ForbiddenError,
    );
  });
});
