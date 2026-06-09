import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import {
  getProjectSlim,
  getProjectGraphSlim,
  getProjectChrome,
  getProjectMaxUpdatedAt,
  getProjectListMaxUpdatedAt,
  getProjectMeta,
  listProjectsSlim,
  listProjectsForMcp,
} from "@/lib/data/project";
import { findProjectAccess } from "@/lib/data/access";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

test("getProjectSlim returns only the slim shape", async () => {
  const f = await seedUserOrgProject("slim");
  const ctx = makeAuthContext(f.userId);

  const p = await getProjectSlim(ctx, f.projectId);

  expect(Object.keys(p).sort()).toEqual([
    "id",
    "identifier",
    "organizationId",
    "status",
    "title",
    "updatedAt",
  ]);
  expect(p.id).toBe(f.projectId);
  expect(p.organizationId).toBe(f.organizationId);
});

test("getProjectGraphSlim drops heavy fields and shapes correctly", async () => {
  const f = await seedUserOrgProject("graphslim");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    const [t1] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "description", "implementation_plan")
      VALUES (${f.projectId}, 'T1', 1, 'desc body', 'plan body')
      RETURNING id
    `;
    const [t2] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number")
      VALUES (${f.projectId}, 'T2', 2)
      RETURNING id
    `;
    await sqlc`
      INSERT INTO task_edges ("source_task_id", "target_task_id", "edge_type", "note")
      VALUES (${t1.id}, ${t2.id}, 'relates_to', 'large edge note')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const g = await getProjectGraphSlim(ctx, f.projectId);

  expect(g.project.id).toBe(f.projectId);
  expect(Object.keys(g.project).sort()).toEqual([
    "categories",
    "id",
    "identifier",
    "organizationId",
    "status",
    "title",
    "updatedAt",
  ]);
  expect(g.tasks.length).toBe(2);
  for (const t of g.tasks) {
    expect(Object.keys(t).sort()).toEqual([
      "assigneeCount",
      "assigneeUserIds",
      "category",
      "estimate",
      "hasCriteria",
      "hasDescription",
      "id",
      "order",
      "priority",
      "state",
      "status",
      "tags",
      "taskRef",
      "title",
      "updatedAt",
    ]);
  }
  const t1 = g.tasks.find((t) => t.title === "T1");
  const t2 = g.tasks.find((t) => t.title === "T2");
  expect(t1?.hasDescription).toBe(true);
  expect(t1?.hasCriteria).toBe(false);
  expect(t2?.hasDescription).toBe(false);
  expect(t2?.hasCriteria).toBe(false);
  // Both tasks are draft + missing criteria, so the slim payload should
  // surface the schema status as the derived state. Locks the contract
  // that `getProjectGraphSlim` actually invokes the server-side derivation.
  expect(t1?.state).toBe("draft");
  expect(t2?.state).toBe("draft");
  expect(g.edges.length).toBe(1);
  expect(Object.keys(g.edges[0]).sort()).toEqual([
    "edgeType",
    "id",
    "sourceTaskId",
    "targetTaskId",
  ]);
});

test("getProjectChrome returns header fields plus task count", async () => {
  const f = await seedUserOrgProject("chrome");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number") VALUES
        (${f.projectId}, 'A', 1),
        (${f.projectId}, 'B', 2),
        (${f.projectId}, 'C', 3)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const c = await getProjectChrome(ctx, f.projectId);
  expect(c.id).toBe(f.projectId);
  expect(c.organization.id).toBe(f.organizationId);
  expect(c.memberRole).toBe("owner");
  expect(c.taskCount).toBe(3);
  expect(Object.keys(c).sort()).toEqual([
    "categories",
    "description",
    "id",
    "identifier",
    "memberRole",
    "organization",
    "status",
    "taskCount",
    "title",
  ]);
});

test("getProjectMeta returns header + tag vocabulary + status-grouped stats", async () => {
  const f = await seedUserOrgProject("meta");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "status", "tags") VALUES
        (${f.projectId}, 'A', 1, 'done',        '["feature","core"]'),
        (${f.projectId}, 'B', 2, 'done',        '["feature","release-blocker"]'),
        (${f.projectId}, 'C', 3, 'in_progress', '["bug","core"]'),
        (${f.projectId}, 'D', 4, 'planned',     '["refactor","normal"]'),
        (${f.projectId}, 'E', 5, 'cancelled',   '["chore","backlog"]')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const m = await getProjectMeta(ctx, f.projectId);

  expect(m.id).toBe(f.projectId);
  expect(Object.keys(m).sort()).toEqual([
    "categories",
    "description",
    "id",
    "identifier",
    "progress",
    "status",
    "tagVocabulary",
    "taskStats",
    "title",
  ]);

  expect(m.taskStats).toEqual({
    total: 5,
    done: 2,
    inProgress: 1,
    cancelled: 1,
  });
  // 2 done out of (5 total - 1 cancelled) = 50%
  expect(m.progress).toBe(50);

  const tagMap = new Map(m.tagVocabulary.map((t) => [t.tag, t.count]));
  expect(tagMap.get("feature")).toBe(2);
  expect(tagMap.get("core")).toBe(2);
  expect(tagMap.get("bug")).toBe(1);
  expect(tagMap.get("refactor")).toBe(1);
  // Sorted by count desc, tie-broken alphabetically
  const counts = m.tagVocabulary.map((t) => t.count);
  expect(counts).toEqual([...counts].sort((a, b) => b - a));
});

test("getProjectMeta on an empty project reports zero stats and empty vocab", async () => {
  const f = await seedUserOrgProject("meta-empty");
  const ctx = makeAuthContext(f.userId);

  const m = await getProjectMeta(ctx, f.projectId);

  expect(m.taskStats).toEqual({
    total: 0,
    done: 0,
    inProgress: 0,
    cancelled: 0,
  });
  expect(m.progress).toBe(0);
  expect(m.tagVocabulary).toEqual([]);
});

test("getProjectMaxUpdatedAt returns the latest updated_at across project + tasks + edges", async () => {
  const f = await seedUserOrgProject("max");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    const future = new Date(Date.now() + 3600_000);
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "updated_at")
      VALUES (${f.projectId}, 'T1', 1, ${future})
    `;
    const max1 = await getProjectMaxUpdatedAt(ctx, f.projectId);
    expect(max1.getTime()).toBeGreaterThanOrEqual(future.getTime() - 1000);

    const farFuture = new Date(Date.now() + 7200_000);
    const [task] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number")
      VALUES (${f.projectId}, 'T2', 2) RETURNING id
    `;
    await sqlc`
      INSERT INTO task_edges ("source_task_id", "target_task_id", "edge_type", "updated_at")
      VALUES (${task.id}, ${task.id}, 'depends_on', ${farFuture})
    `;
    const max2 = await getProjectMaxUpdatedAt(ctx, f.projectId);
    expect(max2.getTime()).toBeGreaterThanOrEqual(farFuture.getTime() - 1000);
  } finally {
    await sqlc.end({ timeout: 5 });
  }
});

test("getProjectListMaxUpdatedAt returns the latest updated_at across the caller's accessible scope", async () => {
  // RLS scopes the row sets; the helper aggregates MAX(updated_at) with
  // no neon_auth join (app_user has no grant there).
  const f = await seedUserOrgProject("listmax");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    const future = new Date(Date.now() + 3600_000);
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "updated_at")
      VALUES (${f.projectId}, 'T1', 1, ${future})
    `;
    const result = await getProjectListMaxUpdatedAt(ctx);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThanOrEqual(future.getTime() - 1000);
  } finally {
    await sqlc.end({ timeout: 5 });
  }
});

test("getProjectListMaxUpdatedAt returns epoch when caller has no projects", async () => {
  const f = await seedUserOrgProject("listmax-empty");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    // Drop the seeded project so the user has zero accessible projects.
    await sqlc`DELETE FROM projects WHERE id = ${f.projectId}`;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const result = await getProjectListMaxUpdatedAt(ctx);
  expect(result).toBeInstanceOf(Date);
  expect(result.getTime()).toBe(0);
});

test("listProjectsSlim aggregates statuses via grouped COUNT", async () => {
  const f = await seedUserOrgProject("counts");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    let seq = 1;
    for (let i = 0; i < 3; i++) {
      await sqlc`
        INSERT INTO tasks ("project_id", "title", "sequence_number", "status")
        VALUES (${f.projectId}, ${"D" + i}, ${seq++}, 'done')
      `;
    }
    for (let i = 0; i < 2; i++) {
      await sqlc`
        INSERT INTO tasks ("project_id", "title", "sequence_number", "status")
        VALUES (${f.projectId}, ${"P" + i}, ${seq++}, 'in_progress')
      `;
    }
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "status")
      VALUES (${f.projectId}, 'X', ${seq++}, 'cancelled')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const page = await listProjectsSlim(ctx);
  const row = page.rows.find((r) => r.id === f.projectId);
  expect(row?.taskStats).toEqual({
    total: 6,
    done: 3,
    inProgress: 2,
    cancelled: 1,
  });
  expect(row?.progress).toBe(60);
});

test("listProjectsSlim paginates with cursor", async () => {
  const f = await seedUserOrgProject("page");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    for (let i = 0; i < 5; i++) {
      await sqlc`
        INSERT INTO projects ("organization_id", "title", "identifier", "updated_at")
        VALUES (${f.organizationId}, ${"P" + i}, ${"PRJ" + i}, ${new Date(Date.now() + (i + 1) * 1000)})
      `;
    }
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const page1 = await listProjectsSlim(ctx, { limit: 3 });
  expect(page1.rows.length).toBe(3);
  expect(page1.nextCursor).not.toBeNull();

  const page2 = await listProjectsSlim(ctx, {
    limit: 3,
    cursor: page1.nextCursor,
  });
  expect(page2.rows.length).toBe(3);
  expect(page2.nextCursor).toBeNull();

  const page1Ids = new Set(page1.rows.map((r) => r.id));
  const page2Ids = new Set(page2.rows.map((r) => r.id));
  for (const id of page2Ids) expect(page1Ids.has(id)).toBe(false);

  expect(page1Ids.size + page2Ids.size).toBe(6);
});

test("listProjectsSlim caps limit at 100", async () => {
  const f = await seedUserOrgProject("cap");
  const ctx = makeAuthContext(f.userId);
  const page = await listProjectsSlim(ctx, { limit: 500 });
  expect(page.rows.length).toBeLessThanOrEqual(100);
});

test("listProjectsForMcp returns the slim agent shape without description, history, categories, or timestamps", async () => {
  const f = await seedUserOrgProject("mcp-shape");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      UPDATE projects
      SET description = ${"x".repeat(5000)}
      WHERE id = ${f.projectId}
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await listProjectsForMcp(ctx);
  const row = rows.find((r) => r.id === f.projectId);
  expect(row).toBeDefined();
  expect(Object.keys(row!).sort()).toEqual([
    "id",
    "identifier",
    "memberRole",
    "organization",
    "organizationId",
    "progress",
    "status",
    "taskStats",
    "title",
  ]);
  expect(Object.keys(row!.organization).sort()).toEqual(["id", "name", "slug"]);
});

test("listProjectsForMcp aggregates task stats and progress like listProjectsSlim", async () => {
  const f = await seedUserOrgProject("mcp-counts");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    let seq = 1;
    for (let i = 0; i < 3; i++) {
      await sqlc`
        INSERT INTO tasks ("project_id", "title", "sequence_number", "status")
        VALUES (${f.projectId}, ${"D" + i}, ${seq++}, 'done')
      `;
    }
    for (let i = 0; i < 2; i++) {
      await sqlc`
        INSERT INTO tasks ("project_id", "title", "sequence_number", "status")
        VALUES (${f.projectId}, ${"P" + i}, ${seq++}, 'in_progress')
      `;
    }
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "status")
      VALUES (${f.projectId}, 'X', ${seq++}, 'cancelled')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await listProjectsForMcp(ctx);
  const row = rows.find((r) => r.id === f.projectId);
  expect(row?.taskStats).toEqual({
    total: 6,
    done: 3,
    inProgress: 2,
    cancelled: 1,
  });
  expect(row?.progress).toBe(60);
});

test("listProjectsForMcp skips teams with zero projects", async () => {
  const f = await seedUserOrgProject("mcp-empty-team");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    const [emptyOrg] = await sqlc<{ id: string }[]>`
      INSERT INTO neon_auth."organization" ("name", "slug", "createdAt")
      VALUES ('Empty Team Mcp', 'empty-team-mcp', now())
      RETURNING id
    `;
    await sqlc`
      INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${emptyOrg.id}, ${f.userId}, 'owner', now())
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await listProjectsForMcp(ctx);
  expect(
    rows.find((r) => r.organization.name === "Empty Team Mcp"),
  ).toBeUndefined();
});

test("findProjectAccess access row omits history and createdAt", async () => {
  const f = await seedUserOrgProject("access-projection");
  const sqlc = superuserPool();
  try {
    await sqlc`
      UPDATE projects
      SET history = ${'[{"kind":"status_change","from":"brainstorming","to":"active","at":"2025-01-01T00:00:00Z"}]'}::jsonb
      WHERE id = ${f.projectId}
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const access = await findProjectAccess(f.userId, f.projectId);

  expect(access).not.toBeNull();
  const keys = Object.keys(access!.project);
  expect(keys).not.toContain("history");
  expect(keys).not.toContain("createdAt");
  expect(keys.sort()).toEqual([
    "categories",
    "description",
    "id",
    "identifier",
    "organizationId",
    "status",
    "title",
    "updatedAt",
  ]);
});
