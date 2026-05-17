import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createEdge, getTaskEdges } from "@/lib/data/edge";

/**
 * Regression test for the cycle-detection bypass: under app_user, the
 * `getDependencyChain` call in `createEdge`/`updateEdge` used to default to
 * the bare `db` client with no `app.user_id` GUC set, so the recursive CTE
 * returned `[]` and `wouldCycle` was always `false`. This let any caller
 * stitch a `depends_on` cycle without detection.
 *
 * The fix moves the cycle check inside the `withUserContext` block and
 * uses `fetchDependencyChain(tx, ...)` directly so the recursive walk
 * participates in the same RLS-scoped transaction frame.
 */

afterEach(async () => {
  await truncateAll();
});

describe("createEdge cycle detection under app_user", () => {
  test("rejects creating an edge that would form a depends_on cycle", async () => {
    const fx = await seedUserOrgProject("cycle-1");
    const sr = serviceRoleConnect();
    let aId: string;
    let cId: string;
    try {
      const [a] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'A', 1) RETURNING id`;
      const [b] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'B', 2) RETURNING id`;
      const [c] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'C', 3) RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${a.id}, ${b.id}, 'depends_on')`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${b.id}, ${c.id}, 'depends_on')`;
      aId = a.id;
      cId = c.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    await expect(
      createEdge(ctx, {
        sourceTaskId: cId,
        targetTaskId: aId,
        edgeType: "depends_on",
        note: "",
      }),
    ).rejects.toThrow(/circular|cycle/i);
  });

  /**
   * Pins RLS-filtered cycle-detection behavior. If a legacy cross-team
   * edge exists (pre-M2-trigger), the cycle detector cannot see foreign
   * tasks, so a cycle that crosses teams is invisible to app_user. This
   * is correct behavior — caller has no access to the foreign tasks, so
   * the cycle is unreachable from their view. The M2 trigger
   * `task_edges_same_project_immutable` is temporarily disabled during
   * setup so legacy-shape data can be inserted.
   */
  test("cycle detector ignores chain links that cross a foreign team", async () => {
    const teamA = await seedUserOrgProject("cycle-cross-a");
    const teamB = await seedUserOrgProject("cycle-cross-b");

    const su = superuserPool();
    let aId: string;
    let bId: string;
    let cId: string;
    try {
      await su`ALTER TABLE task_edges DISABLE TRIGGER task_edges_same_project_immutable`;
      try {
        const [a] = await su<{ id: string }[]>`
          INSERT INTO tasks (project_id, title, sequence_number)
          VALUES (${teamA.projectId}, 'A', 1) RETURNING id`;
        const [b] = await su<{ id: string }[]>`
          INSERT INTO tasks (project_id, title, sequence_number)
          VALUES (${teamB.projectId}, 'B', 1) RETURNING id`;
        const [c] = await su<{ id: string }[]>`
          INSERT INTO tasks (project_id, title, sequence_number)
          VALUES (${teamA.projectId}, 'C', 2) RETURNING id`;
        aId = a.id;
        bId = b.id;
        cId = c.id;
        await su`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
                 VALUES (${aId}, ${bId}, 'depends_on')`;
        await su`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
                 VALUES (${bId}, ${cId}, 'depends_on')`;
      } finally {
        await su`ALTER TABLE task_edges ENABLE TRIGGER task_edges_same_project_immutable`;
      }
    } finally {
      await su.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(teamA.userId);
    const created = await createEdge(ctx, {
      sourceTaskId: cId,
      targetTaskId: aId,
      edgeType: "depends_on",
      note: "",
    });
    expect(created.sourceTaskId).toBe(cId);
    expect(created.targetTaskId).toBe(aId);

    const visible = await getTaskEdges(ctx, aId);
    const endpoints = new Set<string>();
    for (const e of visible) {
      endpoints.add(e.sourceTaskId);
      endpoints.add(e.targetTaskId);
    }
    expect(endpoints.has(bId)).toBe(false);
  });
});
