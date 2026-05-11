import { test, expect, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { getConnectionString } from "@/tests/setup/container";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { createTask, deleteTask, updateTask, searchTasksPaged, getTaskSlim, getTaskFull } from "@/lib/data/task";
import { getProjectMaxUpdatedAt } from "@/lib/data/project";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

test("concurrent createTask calls allocate distinct sequenceNumbers", async () => {
  const f = await seedUserOrgProject("racetest");
  const ctx = makeAuthContext(f.userId);

  const calls = Array.from({ length: 8 }, (_, i) =>
    createTask(ctx, { projectId: f.projectId, title: `T${i}` }),
  );
  const results = await Promise.all(calls);

  const seqs = results.map((r) => r.sequenceNumber).sort((a, b) => a - b);
  expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("concurrent updateTask calls preserve every history entry", async () => {
  const f = await seedUserOrgProject("histrace");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  // Fire 5 concurrent updates on the same task; each appends one history entry.
  const calls = Array.from({ length: 5 }, (_, i) =>
    updateTask(ctx, task.id, { description: `desc-${i}` }),
  );
  await Promise.all(calls);

  const final = await updateTask(ctx, task.id, { description: "final" });
  // 1 created + 5 concurrent updates + 1 final = 7 total entries.
  expect(final.history.length).toBe(7);
});

test("concurrent updateTask calls preserve every appended decision", async () => {
  const f = await seedUserOrgProject("decisionrace");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  // Fire 5 concurrent updates, each appending one unique decision.
  const calls = Array.from({ length: 5 }, (_, i) =>
    updateTask(ctx, task.id, { decisions: [`Decision ${i}`] }),
  );
  await Promise.all(calls);

  const final = await getTaskFull(ctx, task.id);
  const decisions = final.decisions as { text: string }[];
  expect(decisions.length).toBe(5);
  const texts = decisions.map((d) => d.text).sort();
  expect(texts).toEqual([
    "Decision 0",
    "Decision 1",
    "Decision 2",
    "Decision 3",
    "Decision 4",
  ]);
});

test("searchTasksPaged paginates by (order, id) cursor", async () => {
  const f = await seedUserOrgProject("searchpage");
  const ctx = makeAuthContext(f.userId);

  // Seed 6 tasks with explicit order values via raw SQL.
  const sqlc = postgres(getConnectionString(), { max: 1 });
  try {
    for (let i = 0; i < 6; i++) {
      await sqlc`
        INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags")
        VALUES (${f.projectId}, ${"Task " + i}, ${i + 1}, ${i}, '["alpha"]'::jsonb)
      `;
    }
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const page1 = await searchTasksPaged(ctx, f.projectId, { tags: ["alpha"], limit: 3 });
  expect(page1.rows.length).toBe(3);
  expect(page1.nextCursor).not.toBeNull();

  const page2 = await searchTasksPaged(ctx, f.projectId, {
    tags: ["alpha"],
    limit: 3,
    cursor: page1.nextCursor,
  });
  expect(page2.rows.length).toBe(3);
  expect(page2.nextCursor).toBeNull();

  const ids1 = new Set(page1.rows.map((r) => r.id));
  const ids2 = new Set(page2.rows.map((r) => r.id));
  for (const id of ids2) expect(ids1.has(id)).toBe(false);
  expect(ids1.size + ids2.size).toBe(6);
});

test("getTaskSlim returns the slim shape", async () => {
  const f = await seedUserOrgProject("taskslim");
  const ctx = makeAuthContext(f.userId);
  const created = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const t = await getTaskSlim(ctx, created.id);

  expect(Object.keys(t).sort()).toEqual([
    "assigneeCount",
    "category",
    "estimate",
    "id",
    "order",
    "priority",
    "status",
    "tags",
    "taskRef",
    "title",
  ]);
  expect(t.id).toBe(created.id);
  expect(t.title).toBe("T");
  expect(t.taskRef).toMatch(/^[A-Za-z0-9]+-\d+$/);
});

test("getTaskFull returns the full row with composed taskRef", async () => {
  const f = await seedUserOrgProject("taskfull");
  const ctx = makeAuthContext(f.userId);
  const created = await createTask(ctx, { projectId: f.projectId, title: "T2" });

  const t = await getTaskFull(ctx, created.id);

  expect(t.id).toBe(created.id);
  expect(t.title).toBe("T2");
  expect(t.taskRef).toMatch(/^[A-Za-z0-9]+-\d+$/);
  expect(Array.isArray(t.history)).toBe(true);
  expect(Array.isArray(t.acceptanceCriteria)).toBe(true);
});

test("deleteTask keeps the conditional-GET validator monotonic", async () => {
  // Regression guard: deleting the most-recently-touched task previously
  // shrank `max(updated_at)` across project + tasks + edges, which made
  // the workspace graph endpoint return 304 with the stale cached body.
  // `deleteTask` now bumps `projects.updated_at` so the validator never
  // moves backward when the doomed task held the project's max.
  const f = await seedUserOrgProject("delete-monotonic");
  const ctx = makeAuthContext(f.userId);

  const created = await createTask(ctx, { projectId: f.projectId, title: "doomed" });
  // Allow Postgres `now()` to advance past the seed project's `updated_at`
  // so the doomed task strictly holds the project-wide validator.
  await new Promise((r) => setTimeout(r, 50));

  const before = await getProjectMaxUpdatedAt(ctx, f.projectId);
  await deleteTask(ctx, created.id);
  const after = await getProjectMaxUpdatedAt(ctx, f.projectId);

  expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
});

test("createTask with assigneeIds rejects non-team-member users", async () => {
  const f = await seedUserOrgProject("assignee-reject");
  const ctx = makeAuthContext(f.userId);

  // A user who exists but is NOT a member of f's organization.
  const sqlc = postgres(getConnectionString(), { max: 1 });
  let strangerId: string;
  try {
    const [u] = await sqlc<{ id: string }[]>`
      INSERT INTO neon_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES ('Stranger', 'stranger@test.local', true, now())
      RETURNING id
    `;
    strangerId = u.id;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  await expect(
    createTask(ctx, {
      projectId: f.projectId,
      title: "T",
      assigneeIds: [strangerId],
    }),
  ).rejects.toThrow(/not a member/);
});

test("updateTask appends assigneeIds by default and replaces with overwriteArrays", async () => {
  const f = await seedUserOrgProject("assignee-modes");
  const ctx = makeAuthContext(f.userId);

  // Add a second member to the same org.
  const sqlc = postgres(getConnectionString(), { max: 1 });
  let secondId: string;
  try {
    const [u] = await sqlc<{ id: string }[]>`
      INSERT INTO neon_auth."user" ("name", "email", "emailVerified", "updatedAt")
      VALUES ('Second', 'second@test.local', true, now())
      RETURNING id
    `;
    secondId = u.id;
    await sqlc`
      INSERT INTO neon_auth."member" ("organizationId", "userId", "role", "createdAt")
      VALUES (${f.organizationId}, ${secondId}, 'member', now())
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    assigneeIds: [f.userId],
  });

  // Default append: adding `secondId` keeps `f.userId`.
  await updateTask(ctx, task.id, { assigneeIds: [secondId] });
  let full = await getTaskFull(ctx, task.id);
  let ids = full.assignees.map((a) => a.userId).sort();
  expect(ids).toEqual([f.userId, secondId].sort());

  // overwriteArrays=true REPLACES.
  await updateTask(ctx, task.id, { assigneeIds: [secondId] }, true);
  full = await getTaskFull(ctx, task.id);
  ids = full.assignees.map((a) => a.userId);
  expect(ids).toEqual([secondId]);

  // overwriteArrays=true with empty array clears all.
  await updateTask(ctx, task.id, { assigneeIds: [] }, true);
  full = await getTaskFull(ctx, task.id);
  expect(full.assignees).toEqual([]);
});

test("createTask with priority and estimate persists both fields", async () => {
  const f = await seedUserOrgProject("priority-estimate");
  const ctx = makeAuthContext(f.userId);

  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    priority: "release-blocker",
    estimate: 8,
  });
  const full = await getTaskFull(ctx, task.id);
  expect(full.priority).toBe("release-blocker");
  expect(full.estimate).toBe(8);
});
