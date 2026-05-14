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
  expect(final.decisions.length).toBe(5);
  const texts = final.decisions.map((d) => d.text).sort();
  expect(texts).toEqual([
    "Decision 0",
    "Decision 1",
    "Decision 2",
    "Decision 3",
    "Decision 4",
  ]);
});

test("concurrent updateTask calls preserve every appended criterion", async () => {
  const f = await seedUserOrgProject("criteriarace");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const calls = Array.from({ length: 5 }, (_, i) =>
    updateTask(ctx, task.id, { acceptanceCriteria: [`Criterion ${i}`] }),
  );
  await Promise.all(calls);

  const final = await getTaskFull(ctx, task.id);
  expect(final.acceptanceCriteria.length).toBe(5);
  const texts = final.acceptanceCriteria.map((c) => c.text).sort();
  expect(texts).toEqual([
    "Criterion 0",
    "Criterion 1",
    "Criterion 2",
    "Criterion 3",
    "Criterion 4",
  ]);
});

test("criteria replace via overwriteArrays=true clears prior entries", async () => {
  const f = await seedUserOrgProject("criteriareplace");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A", "B", "C"],
  });

  await updateTask(ctx, task.id, { acceptanceCriteria: ["D"] }, true);

  const final = await getTaskFull(ctx, task.id);
  expect(final.acceptanceCriteria.length).toBe(1);
  expect(final.acceptanceCriteria[0].text).toBe("D");
});

test("decisions replace via overwriteArrays=true clears prior entries", async () => {
  const f = await seedUserOrgProject("decisionsreplace");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    decisions: ["First", "Second", "Third"],
  });

  await updateTask(ctx, task.id, { decisions: ["Final"] }, true);

  const final = await getTaskFull(ctx, task.id);
  expect(final.decisions.length).toBe(1);
  expect(final.decisions[0].text).toBe("Final");
});

test("deleteTask cascades criteria and decisions", async () => {
  const f = await seedUserOrgProject("cascadechildren");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A", "B"],
    decisions: ["D1", "D2"],
  });

  await deleteTask(ctx, task.id);

  const sqlc = postgres(getConnectionString(), { max: 1 });
  try {
    const [acRow] = await sqlc<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM task_acceptance_criteria WHERE task_id = ${task.id}
    `;
    const [decRow] = await sqlc<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM task_decisions WHERE task_id = ${task.id}
    `;
    expect(Number(acRow.count)).toBe(0);
    expect(Number(decRow.count)).toBe(0);
  } finally {
    await sqlc.end({ timeout: 5 });
  }
});

test("foreign key rejects orphan criterion insert", async () => {
  await seedUserOrgProject("orphancriterion");

  const sqlc = postgres(getConnectionString(), { max: 1 });
  try {
    const orphanTaskId = "00000000-0000-0000-0000-000000000001";
    const orphanCriterionId = "00000000-0000-0000-0000-000000000002";
    let threw = false;
    try {
      await sqlc`
        INSERT INTO task_acceptance_criteria (id, task_id, text, checked, position)
        VALUES (${orphanCriterionId}::uuid, ${orphanTaskId}::uuid, 'orphan', false, 0)
      `;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  } finally {
    await sqlc.end({ timeout: 5 });
  }
});

test("append-mode dedup replaces same-id and same-text criterion entries", async () => {
  const f = await seedUserOrgProject("dedup");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: [{ id: "11111111-1111-4111-8111-111111111111", text: "X" }],
  });

  // Same id: row replaced in-place; text updated.
  await updateTask(ctx, task.id, {
    acceptanceCriteria: [
      { id: "11111111-1111-4111-8111-111111111111", text: "X-modified" },
    ],
  });
  let full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.length).toBe(1);
  expect(full.acceptanceCriteria[0].id).toBe("11111111-1111-4111-8111-111111111111");
  expect(full.acceptanceCriteria[0].text).toBe("X-modified");

  // Same text, different id: the old id row is deleted (text-match dedup) and
  // the new id is inserted with the updated text.
  await updateTask(ctx, task.id, {
    acceptanceCriteria: [
      { id: "22222222-2222-4222-8222-222222222222", text: "X-modified" },
    ],
  });
  full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.length).toBe(1);
  expect(full.acceptanceCriteria[0].id).toBe("22222222-2222-4222-8222-222222222222");
  expect(full.acceptanceCriteria[0].text).toBe("X-modified");
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
    priority: "urgent",
    estimate: 8,
  });
  const full = await getTaskFull(ctx, task.id);
  expect(full.priority).toBe("urgent");
  expect(full.estimate).toBe(8);
});

test("getTaskFull returns empty arrays (not null) when no children exist", async () => {
  // Regression guard: the raw SQL projection uses LEFT-LATERAL `json_agg`
  // subqueries that return NULL when the child table has no matching
  // rows. The mapper must coerce NULL → [] so consumers can read
  // `.length` without an undefined-trap. Protects every list/iterate
  // call site that assumes the typed contract (`AcceptanceCriterion[]`,
  // `Decision[]`, `AssigneeRef[]`, `TaskLinkRef[]`) holds even when the
  // task has no rows in the respective child table.
  const f = await seedUserOrgProject("empty-children");
  const ctx = makeAuthContext(f.userId);
  const created = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const full = await getTaskFull(ctx, created.id);
  expect(full.acceptanceCriteria).toEqual([]);
  expect(full.decisions).toEqual([]);
  expect(full.assignees).toEqual([]);
  expect(full.links).toEqual([]);
});

test("searchTasksPaged reports hasCriteria correctly via correlated EXISTS", async () => {
  // Regression guard for MYMR-136 cleanup: the prior `criteriaCountSubquery()`
  // helper materialized a global `GROUP BY` across the entire child table
  // (per-list-call scan of every project's criteria), so it was replaced by
  // a correlated `EXISTS` semi-join. The boolean logic must yield the same
  // observable state through `deriveTaskStatesSlim`.
  const f = await seedUserOrgProject("hascriteria-leftjoin");
  const ctx = makeAuthContext(f.userId);
  const withAc = await createTask(ctx, {
    projectId: f.projectId,
    title: "with-ac",
    acceptanceCriteria: ["First criterion"],
  });
  const withoutAc = await createTask(ctx, {
    projectId: f.projectId,
    title: "without-ac",
  });

  const page = await searchTasksPaged(ctx, f.projectId, { limit: 50 });
  const ids = new Set(page.rows.map((r) => r.id));
  expect(ids.has(withAc.id)).toBe(true);
  expect(ids.has(withoutAc.id)).toBe(true);
  // The boolean drives `deriveTaskStatesSlim`: with-ac + non-empty
  // description ⇒ `plannable`; without-ac ⇒ `draft`. The state
  // projection on the row is the observable proxy for the join result.
  const withAcRow = page.rows.find((r) => r.id === withAc.id);
  const withoutAcRow = page.rows.find((r) => r.id === withoutAc.id);
  // Tasks have empty description by default — the state stays `draft`
  // regardless of `hasCriteria` until a description is set. Add one
  // to the with-ac task to confirm `hasCriteria` lifts it to `plannable`.
  await updateTask(ctx, withAc.id, { description: "desc" });
  await updateTask(ctx, withoutAc.id, { description: "desc" });
  const refreshed = await searchTasksPaged(ctx, f.projectId, { limit: 50 });
  const updatedWithAc = refreshed.rows.find((r) => r.id === withAc.id);
  const updatedWithoutAc = refreshed.rows.find((r) => r.id === withoutAc.id);
  expect(updatedWithAc?.state).toBe("plannable");
  expect(updatedWithoutAc?.state).toBe("draft");
  // Touch the unused page captures so the linter does not complain
  // about destructured results — and so the explicit assertions on
  // the pre-description state stay close to the lift assertions.
  expect(withAcRow).toBeDefined();
  expect(withoutAcRow).toBeDefined();
});

test("concurrent same-text criterion appends collapse to one row via unique(task_id, text)", async () => {
  const f = await seedUserOrgProject("dedupracecrit");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const calls = Array.from({ length: 10 }, () =>
    updateTask(ctx, task.id, { acceptanceCriteria: ["duplicate-X"] }),
  );
  await Promise.all(calls);

  const final = await getTaskFull(ctx, task.id);
  const sameText = final.acceptanceCriteria.filter((c) => c.text === "duplicate-X");
  expect(sameText.length).toBe(1);
});

test("concurrent same-text decision appends collapse to one row via unique(task_id, text)", async () => {
  const f = await seedUserOrgProject("dedupracedec");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const calls = Array.from({ length: 10 }, () =>
    updateTask(ctx, task.id, { decisions: ["duplicate-Y"] }),
  );
  await Promise.all(calls);

  const final = await getTaskFull(ctx, task.id);
  const sameText = final.decisions.filter((d) => d.text === "duplicate-Y");
  expect(sameText.length).toBe(1);
});
