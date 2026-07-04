import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask, normalizeContextGolden } from "./fixtures";
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

  test("cancelled middle is transparent in prerequisites but named as abandoned", async () => {
    // A depends_on B(cancelled) depends_on C(active). The planning bundle
    // for A must show C as a prerequisite, never B; B surfaces only under
    // Abandoned Approaches.
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
    expect(result).not.toContain("**Cancelled middle B**");
    expect(result).toContain("## Abandoned Approaches");
    expect(result).toContain("Cancelled middle B");
    expect(result).toContain("(no rationale recorded)");
  });

  test("golden: fully-populated task renders byte-identical planning context", async () => {
    const fx = await seedRichContextTask("planning-ctx-golden");
    const ctx = makeAuthContext(fx.userId);
    const result = await buildPlanningContext(ctx, fx.taskId);
    expect(
      normalizeContextGolden(result, "planning-ctx-golden"),
    ).toMatchSnapshot();
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

  test("renders task links and abandoned approaches from cancelled deps", async () => {
    const fx = await seedRichContextTask("planning-ctx-abandoned");
    const sr = serviceRoleConnect();
    try {
      const [dead] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description, status, execution_record)
        SELECT project_id, 'Dead-end approach', 9, 'tried and dropped', 'cancelled', 'Tried X; X cannot work because Y'
        FROM tasks WHERE id = ${fx.taskId}
        RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${fx.taskId}, ${dead.id}, 'depends_on')`;
      await sr`INSERT INTO task_links (task_id, url, kind)
               VALUES (${dead.id}, 'https://example.test/pr/66', 'pull_request')`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildPlanningContext(ctx, fx.taskId);
    expect(result).toContain("## Abandoned Approaches");
    expect(result).toContain("Tried X; X cannot work because Y");
    expect(result).toContain(
      "PR: https://example.test/pr/66 — closed, unmerged",
    );
    expect(result).toContain("## Links");
    expect(result).toContain("https://example.test/pr/1");
    // Cancelled deps are transparent to the effective walk: never a prerequisite row.
    expect(result).not.toContain("**Dead-end approach** [cancelled]");
  });

  test("marks a cancelled dep without a rationale instead of hiding it", async () => {
    const fx = await seedRichContextTask("planning-ctx-bare-cancel");
    const sr = serviceRoleConnect();
    try {
      const [dead] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description, status)
        SELECT project_id, 'Silent abandonment', 9, 'dropped without notes', 'cancelled'
        FROM tasks WHERE id = ${fx.taskId}
        RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${fx.taskId}, ${dead.id}, 'depends_on')`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildPlanningContext(ctx, fx.taskId);
    expect(result).toContain("## Abandoned Approaches");
    expect(result).toContain("Silent abandonment");
    expect(result).toContain("(no rationale recorded)");
  });

  test("upstream execution records carry the done dep's PR link", async () => {
    const fx = await seedRichContextTask("planning-ctx-dep-pr");
    const sr = serviceRoleConnect();
    try {
      await sr`INSERT INTO task_links (task_id, url, kind)
               SELECT id, 'https://example.test/pr/41', 'pull_request'
               FROM tasks
               WHERE title = 'Prereq task'
                 AND project_id = (SELECT project_id FROM tasks WHERE id = ${fx.taskId})`;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildPlanningContext(ctx, fx.taskId);
    const built = result.slice(
      result.indexOf("## What's Been Built (from done prerequisites)"),
    );
    expect(built).toContain("PR: https://example.test/pr/41");
  });
});
