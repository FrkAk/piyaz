import { test, expect, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { getConnectionString } from "@/tests/setup/container";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { createTask, updateTask, searchTasksPaged, getTaskSlim, getTaskFull } from "@/lib/data/task";
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
    "category",
    "id",
    "order",
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
