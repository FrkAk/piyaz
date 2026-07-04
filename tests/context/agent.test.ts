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

  test("agent bundle drops assignees and closes on constraints then done-means", async () => {
    const fx = await seedRichContextTask("agent-ctx-tail");
    const result = await buildAgentContext(
      makeAuthContext(fx.userId),
      fx.taskId,
    );
    expect(result).not.toContain("## Assignees");
    expect(result).not.toContain("## Files");
    const constraintsIdx = result.indexOf("## Constraints");
    const doneMeansIdx = result.indexOf("## Done Means");
    expect(constraintsIdx).toBeGreaterThan(result.indexOf("## Downstream"));
    expect(doneMeansIdx).toBeGreaterThan(constraintsIdx);
    expect(result.indexOf("## Links")).toBeLessThan(
      result.indexOf("## Execution Record"),
    );
  });

  test("upstream execution records carry the dep's PR link", async () => {
    const fx = await seedRichContextTask("agent-ctx-dep-pr");
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

    const result = await buildAgentContext(
      makeAuthContext(fx.userId),
      fx.taskId,
    );
    const built = result.slice(result.indexOf("## Upstream Execution Records"));
    expect(built).toContain("PR: https://example.test/pr/41");
  });
});

/**
 * Seed a base task with one done dep (with record) and one draft dep.
 *
 * @param suffix - Fixture suffix so seeds don't collide.
 * @param status - Status of the main task.
 * @returns Fixture ids plus the main and draft-dep task ids.
 */
async function seedBlockedFixture(suffix: string, status: string) {
  const fx = await seedUserOrgProject(suffix);
  const sr = serviceRoleConnect();
  try {
    const [main] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description, status, implementation_plan)
      VALUES (${fx.projectId}, 'Main task', 1, 'main spec', ${status}, 'the plan')
      RETURNING id`;
    const [doneDep] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description, status, execution_record)
      VALUES (${fx.projectId}, 'Done dep', 2, 'shipped', 'done', 'dep record')
      RETURNING id`;
    const [draftDep] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description, status)
      VALUES (${fx.projectId}, 'Draft dep', 3, 'unshipped', 'draft')
      RETURNING id`;
    await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
             VALUES (${main.id}, ${doneDep.id}, 'depends_on', 'uses output'),
                    (${main.id}, ${draftDep.id}, 'depends_on', 'waits on api')`;
    return { ...fx, mainId: main.id, draftDepId: draftDep.id };
  } finally {
    await sr.end({ timeout: 5 });
  }
}

describe("agent bundle blocked notice", () => {
  test("planned task with an unfinished direct dep gets the blocked notice", async () => {
    const fx = await seedBlockedFixture("agent-blocked-planned", "planned");
    const result = await buildAgentContext(
      makeAuthContext(fx.userId),
      fx.mainId,
    );
    expect(result).toContain("## ⚠ Blocked — do not implement");
    expect(result).toContain(
      "This task's prerequisites are not done. Building now means building against unshipped interfaces, and the lifecycle forbids it. Treat this bundle as read-ahead context only.",
    );
    expect(result).toContain("**Draft dep** [draft] — waits on api");
    const blockedBody = result.slice(
      result.indexOf("## ⚠ Blocked"),
      result.indexOf("## Implementation Plan"),
    );
    expect(blockedBody).not.toContain("Done dep");
    expect(result.indexOf("## ⚠ Blocked")).toBeLessThan(
      result.indexOf("## Implementation Plan"),
    );
  });

  test("draft task leads the notice with the premature-dispatch line", async () => {
    const fx = await seedBlockedFixture("agent-blocked-draft", "draft");
    const result = await buildAgentContext(
      makeAuthContext(fx.userId),
      fx.mainId,
    );
    expect(result).toContain(
      "This task is a `draft` with no implementation plan; it must be planned before any implementation.",
    );
  });

  test("in_progress task with an unfinished direct dep gets the notice", async () => {
    const fx = await seedBlockedFixture(
      "agent-blocked-progress",
      "in_progress",
    );
    const result = await buildAgentContext(
      makeAuthContext(fx.userId),
      fx.mainId,
    );
    expect(result).toContain("## ⚠ Blocked — do not implement");
  });

  test("absent when every direct dep is done", async () => {
    const fx = await seedBlockedFixture("agent-blocked-alldone", "planned");
    const sr = serviceRoleConnect();
    try {
      await sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.draftDepId}`;
    } finally {
      await sr.end({ timeout: 5 });
    }
    const result = await buildAgentContext(
      makeAuthContext(fx.userId),
      fx.mainId,
    );
    expect(result).not.toContain("⚠ Blocked");
  });

  test("absent when only a 2-hop dep is unfinished", async () => {
    // main -> middle(done) -> far(draft): far is depth 2, no notice.
    const fx = await seedUserOrgProject("agent-blocked-2hop");
    const sr = serviceRoleConnect();
    let mainId: string;
    try {
      const [main] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description, status)
        VALUES (${fx.projectId}, 'Main', 1, 'spec', 'planned') RETURNING id`;
      const [middle] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description, status)
        VALUES (${fx.projectId}, 'Middle', 2, 'spec', 'done') RETURNING id`;
      const [far] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, description, status)
        VALUES (${fx.projectId}, 'Far', 3, 'spec', 'draft') RETURNING id`;
      await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
               VALUES (${main.id}, ${middle.id}, 'depends_on'),
                      (${middle.id}, ${far.id}, 'depends_on')`;
      mainId = main.id;
    } finally {
      await sr.end({ timeout: 5 });
    }
    const result = await buildAgentContext(makeAuthContext(fx.userId), mainId);
    expect(result).not.toContain("⚠ Blocked");
  });
});

describe("closure depth-cap visibility", () => {
  /**
   * Seed a 4-task depends_on chain d3 → d2 → d1 → head, bypassing RLS.
   *
   * @param projectId - Owning project id.
   * @returns Ids of the chain ends: head (everything depends on it) and
   *   d3 (depends on everything).
   */
  async function seedChain(
    projectId: string,
  ): Promise<{ headId: string; tailId: string }> {
    const sr = serviceRoleConnect();
    try {
      const ids: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const [t] = await sr<{ id: string }[]>`
          INSERT INTO tasks (project_id, title, sequence_number, description, status)
          VALUES (${projectId}, ${"Chain task " + i}, ${i}, 'chain member', 'planned')
          RETURNING id`;
        ids.push(t.id);
      }
      for (let i = 1; i < 4; i++) {
        await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
                 VALUES (${ids[i]}, ${ids[i - 1]}, 'depends_on')`;
      }
      return { headId: ids[0], tailId: ids[3] };
    } finally {
      await sr.end({ timeout: 5 });
    }
  }

  test("a depth-3 chain surfaces the piyaz_map pointer instead of truncating silently", async () => {
    const fx = await seedUserOrgProject("agent-depthcap");
    const { headId, tailId } = await seedChain(fx.projectId);
    const ctx = makeAuthContext(fx.userId);

    const headBundle = await buildAgentContext(ctx, headId);
    expect(headBundle).toContain("Chain task 2");
    expect(headBundle).toContain("Chain task 3");
    expect(headBundle).not.toContain("Chain task 4");
    expect(headBundle).toContain("deeper dependents exist beyond depth 2");
    expect(headBundle).toContain("piyaz_map view='downstream'");

    const tailBundle = await buildAgentContext(ctx, tailId);
    expect(tailBundle).toContain("prerequisite chain continues beyond depth 2");
  });

  test("a depth-2 chain emits no truncation pointer", async () => {
    const fx = await seedUserOrgProject("agent-depth2");
    const sr = serviceRoleConnect();
    let headId: string;
    try {
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const [t] = await sr<{ id: string }[]>`
          INSERT INTO tasks (project_id, title, sequence_number, description, status)
          VALUES (${fx.projectId}, ${"Short chain " + i}, ${i}, 'chain member', 'planned')
          RETURNING id`;
        ids.push(t.id);
      }
      for (let i = 1; i < 3; i++) {
        await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type)
                 VALUES (${ids[i]}, ${ids[i - 1]}, 'depends_on')`;
      }
      headId = ids[0];
    } finally {
      await sr.end({ timeout: 5 });
    }

    const bundle = await buildAgentContext(makeAuthContext(fx.userId), headId);
    expect(bundle).toContain("Short chain 3");
    expect(bundle).not.toContain("deeper dependents exist");
  });
});
