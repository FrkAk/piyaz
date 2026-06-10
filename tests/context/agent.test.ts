import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask, normalizeContextGolden } from "./fixtures";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

describe("buildAgentContext under app_user", () => {
  test("returns populated dependency chain for an authorized caller", async () => {
    const fx = await seedUserOrgProject("agent-ctx-1");
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
    const result = await buildAgentContext(ctx, childTaskId);
    expect(result).not.toBeNull();
    // Title appears only when the dependency walk succeeded — the regression
    // gate: without the withUserContext wrap, RLS default-denies and the deps
    // section is empty (no "Parent task" substring).
    expect(result).toContain("Parent task");
  });

  test("cancelled middle is transparent: C surfaces, B does not", async () => {
    // A depends_on B(cancelled) depends_on C(active). The bundle for A must
    // show C as a prerequisite (reached through the cancelled middle at
    // effective depth 1) and must never list B.
    const fx = await seedUserOrgProject("agent-ctx-cancel");
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
    const result = await buildAgentContext(ctx, aTaskId);
    expect(result).toContain("Active wall C");
    expect(result).not.toContain("Cancelled middle B");
  });

  test("golden: fully-populated task renders byte-identical agent context", async () => {
    const fx = await seedRichContextTask("agent-ctx-golden");
    const ctx = makeAuthContext(fx.userId);
    const result = await buildAgentContext(ctx, fx.taskId);
    expect(
      normalizeContextGolden(result, "agent-ctx-golden"),
    ).toMatchSnapshot();
  });

  test("rejects cross-team callers (RLS isolation)", async () => {
    const fxA = await seedUserOrgProject("agent-ctx-a");
    const fxB = await seedUserOrgProject("agent-ctx-b");
    const sr = serviceRoleConnect();
    let taskInA: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxA.projectId}, 'A task', 1)
        RETURNING id`;
      taskInA = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fxB.userId);
    await expect(buildAgentContext(ctx, taskInA)).rejects.toThrow(
      ForbiddenError,
    );
  });
});
