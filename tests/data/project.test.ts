import { test, expect, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { getConnectionString } from "@/tests/setup/container";
import {
  getProjectSlim,
  getProjectGraphSlim,
  getProjectChrome,
  getProjectMaxUpdatedAt,
  listProjectsSlim,
} from "@/lib/data/project";
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

  const sqlc = postgres(getConnectionString(), { max: 1 });
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "description", "implementation_plan")
      VALUES (${f.projectId}, 'T1', 1, 'desc body', 'plan body')
    `;
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number")
      VALUES (${f.projectId}, 'T2', 2)
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
    "status",
    "title",
    "updatedAt",
  ]);
  expect(g.tasks.length).toBe(2);
  for (const t of g.tasks) {
    expect(Object.keys(t).sort()).toEqual([
      "category",
      "hasCriteria",
      "hasDescription",
      "id",
      "order",
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
});

test("getProjectChrome returns header fields plus task count", async () => {
  const f = await seedUserOrgProject("chrome");
  const ctx = makeAuthContext(f.userId);

  const sqlc = postgres(getConnectionString(), { max: 1 });
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

test("getProjectMaxUpdatedAt returns the latest updated_at across project + tasks + edges", async () => {
  const f = await seedUserOrgProject("max");
  const ctx = makeAuthContext(f.userId);

  const sqlc = postgres(getConnectionString(), { max: 1 });
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

test("listProjectsSlim aggregates statuses via grouped COUNT", async () => {
  const f = await seedUserOrgProject("counts");
  const ctx = makeAuthContext(f.userId);

  const sqlc = postgres(getConnectionString(), { max: 1 });
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
  expect(row?.taskStats).toEqual({ total: 6, done: 3, inProgress: 2, cancelled: 1 });
  expect(row?.progress).toBe(60);
});

test("listProjectsSlim paginates with cursor", async () => {
  const f = await seedUserOrgProject("page");
  const ctx = makeAuthContext(f.userId);

  const sqlc = postgres(getConnectionString(), { max: 1 });
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
