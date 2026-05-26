import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import {
  createTask,
  deleteTask,
  updateTask,
  searchTasks,
  searchTasksPaged,
  searchTasksAcrossProjects,
  listMyTasks,
  deriveLifecycleStage,
  getTaskSlim,
  getTaskFull,
} from "@/lib/data/task";
import { getProjectMaxUpdatedAt } from "@/lib/data/project";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

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

  const sqlc = superuserPool();
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

  const sqlc = superuserPool();
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
    acceptanceCriteria: [
      { id: "11111111-1111-4111-8111-111111111111", text: "X" },
    ],
  });

  // Same id: row replaced in-place; text updated.
  await updateTask(ctx, task.id, {
    acceptanceCriteria: [
      { id: "11111111-1111-4111-8111-111111111111", text: "X-modified" },
    ],
  });
  let full = await getTaskFull(ctx, task.id);
  expect(full.acceptanceCriteria.length).toBe(1);
  expect(full.acceptanceCriteria[0].id).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
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
  expect(full.acceptanceCriteria[0].id).toBe(
    "22222222-2222-4222-8222-222222222222",
  );
  expect(full.acceptanceCriteria[0].text).toBe("X-modified");
});

test("searchTasksPaged paginates by (order, id) cursor", async () => {
  const f = await seedUserOrgProject("searchpage");
  const ctx = makeAuthContext(f.userId);

  // Seed 6 tasks with explicit order values via raw SQL.
  const sqlc = superuserPool();
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

  const page1 = await searchTasksPaged(ctx, f.projectId, {
    tags: ["alpha"],
    limit: 3,
  });
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

test("searchTasks tags-only filter omits relevance rank to avoid ORDER BY 0", async () => {
  const f = await seedUserOrgProject("searchtagsonly");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags")
      VALUES (${f.projectId}, 'X', 1, 1, '["feature"]'::jsonb)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasks(ctx, f.projectId, { tags: ["feature"] });
  expect(rows.length).toBe(1);
  expect(rows[0].tags).toEqual(["feature"]);
});

test("searchTasks category-only filter returns tasks in that category ordered by tasks.order ASC", async () => {
  const f = await seedUserOrgProject("searchcatonly");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags", "category")
      VALUES
        (${f.projectId}, 'C2', 1, 20, '[]'::jsonb, 'MCP'),
        (${f.projectId}, 'C0', 2, 10, '[]'::jsonb, 'MCP'),
        (${f.projectId}, 'C1', 3, 30, '[]'::jsonb, 'Data'),
        (${f.projectId}, 'C3', 4, 40, '[]'::jsonb, 'MCP')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasks(ctx, f.projectId, { category: "MCP" });
  expect(rows.map((r) => r.title)).toEqual(["C0", "C2", "C3"]);
  for (const r of rows) expect(r.category).toBe("MCP");
});

test("searchTasks category + tags AND-narrows", async () => {
  const f = await seedUserOrgProject("searchcattags");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags", "category")
      VALUES
        (${f.projectId}, 'A', 1, 10, '["feature"]'::jsonb, 'MCP'),
        (${f.projectId}, 'B', 2, 20, '["bug"]'::jsonb, 'MCP'),
        (${f.projectId}, 'C', 3, 30, '["feature"]'::jsonb, 'Data'),
        (${f.projectId}, 'D', 4, 40, '["bug"]'::jsonb, 'Data')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasks(ctx, f.projectId, {
    tags: ["feature"],
    category: "MCP",
  });
  expect(rows.map((r) => r.title)).toEqual(["A"]);
});

test("searchTasks category + query AND-narrows", async () => {
  const f = await seedUserOrgProject("searchcatquery");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags", "category")
      VALUES
        (${f.projectId}, 'auth refactor', 1, 10, '[]'::jsonb, 'MCP'),
        (${f.projectId}, 'auth refactor', 2, 20, '[]'::jsonb, 'Data'),
        (${f.projectId}, 'storage tweak', 3, 30, '[]'::jsonb, 'MCP')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasks(ctx, f.projectId, {
    query: "auth",
    category: "MCP",
  });
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("auth refactor");
  expect(rows[0].category).toBe("MCP");
});

test("searchTasks category-only with no matches returns empty array", async () => {
  const f = await seedUserOrgProject("searchcatnomatch");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags", "category")
      VALUES (${f.projectId}, 'X', 1, 1, '[]'::jsonb, 'MCP')
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasks(ctx, f.projectId, { category: "Data" });
  expect(rows).toEqual([]);
});

test("searchTasksAcrossProjects returns [] for empty / whitespace queries", async () => {
  const f = await seedUserOrgProject("xprojempty");
  const ctx = makeAuthContext(f.userId);

  expect(await searchTasksAcrossProjects(ctx, "")).toEqual([]);
  expect(await searchTasksAcrossProjects(ctx, "   ")).toEqual([]);
});

test("searchTasksAcrossProjects excludes tasks in orgs the caller is not a member of", async () => {
  const me = await seedUserOrgProject("xprojme");
  const other = await seedUserOrgProject("xprojother");
  const ctx = makeAuthContext(me.userId);

  // Seed one matching task in MY project and one in OTHER's project; both share the title.
  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${me.projectId}, 'Crossproject palette query', 1, 1)
    `;
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${other.projectId}, 'Crossproject palette query', 1, 1)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasksAcrossProjects(ctx, "palette");
  expect(rows.length).toBe(1);
  expect(rows[0].projectId).toBe(me.projectId);
  expect(rows[0].organizationId).toBe(me.organizationId);
  expect(rows[0].title).toBe("Crossproject palette query");
});

test("searchTasksAcrossProjects taskRef short-circuit hits the exact task", async () => {
  const f = await seedUserOrgProject("XPROJREF");
  const ctx = makeAuthContext(f.userId);

  // `seedUserOrgProject` creates project identifier `PRJ<suffix>`; here PRJXPROJREF.
  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'First', 1, 1)
    `;
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Second', 2, 2)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasksAcrossProjects(ctx, "PRJXPROJREF-2");
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("Second");
  expect(rows[0].taskRef).toBe("PRJXPROJREF-2");

  // Non-matching prefix returns empty (no fallback to title substring).
  const miss = await searchTasksAcrossProjects(ctx, "OTHER-2");
  expect(miss).toEqual([]);
});

test("searchTasksAcrossProjects matches tag substring", async () => {
  const f = await seedUserOrgProject("xprojtag");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags")
      VALUES (${f.projectId}, 'No match in title', 1, 1, '["palette-tag"]'::jsonb)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasksAcrossProjects(ctx, "palette-tag");
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("No match in title");
});

test("searchTasksAcrossProjects AND-matches multiple whitespace-separated tokens", async () => {
  const f = await seedUserOrgProject("XPROJTOK");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Fix bug in auth login', 1, 1)
    `;
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Add login form', 2, 2)
    `;
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Unrelated crash report', 3, 3)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  // Tokens in any order: both "auth" and "bug" must appear somewhere.
  const rows = await searchTasksAcrossProjects(ctx, "auth bug");
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("Fix bug in auth login");

  // "login form" matches "Add login form" directly (both tokens in title).
  const rows2 = await searchTasksAcrossProjects(ctx, "login form");
  expect(rows2.length).toBe(1);
  expect(rows2[0].title).toBe("Add login form");

  // Token that matches nothing collapses the result set.
  const rows3 = await searchTasksAcrossProjects(ctx, "auth zzznope");
  expect(rows3).toEqual([]);
});

test("searchTasksAcrossProjects surfaces tasks when the project title or identifier matches", async () => {
  const f = await seedUserOrgProject("XPROJPROJMATCH");
  const ctx = makeAuthContext(f.userId);

  // Project from seed: title "Project XPROJPROJMATCH", identifier "PRJXPROJPROJMATCH".
  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Wholly unrelated title', 1, 1)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  // Query matches project title token.
  const byTitle = await searchTasksAcrossProjects(ctx, "XPROJPROJMATCH");
  expect(byTitle.length).toBe(1);
  expect(byTitle[0].title).toBe("Wholly unrelated title");

  // Query matches project identifier as a substring.
  const byIdent = await searchTasksAcrossProjects(ctx, "PRJXPROJPROJMATCH");
  expect(byIdent.length).toBe(1);
  expect(byIdent[0].title).toBe("Wholly unrelated title");
});

test("searchTasksAcrossProjects matches a bare sequence number", async () => {
  const f = await seedUserOrgProject("XPROJSEQ");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Some title', 191, 1)
    `;
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Other title', 7, 2)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await searchTasksAcrossProjects(ctx, "191");
  const seqs = rows.map((r) => r.taskRef);
  expect(seqs).toContain("PRJXPROJSEQ-191");
});

test("searchTasksAcrossProjects accepts a partial taskRef with trailing dash", async () => {
  const f = await seedUserOrgProject("XPROJPARTIAL");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'First in partial', 1, 1)
    `;
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${f.projectId}, 'Second in partial', 2, 2)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  // "PRJXPROJPARTIAL-" is a partial taskRef (no sequence number). Should
  // surface every task in that project rather than returning empty.
  const rows = await searchTasksAcrossProjects(ctx, "PRJXPROJPARTIAL-");
  expect(rows.length).toBe(2);
  const titles = rows.map((r) => r.title).sort();
  expect(titles).toEqual(["First in partial", "Second in partial"]);
});

test("searchTasksAcrossProjects orders results deterministically across calls", async () => {
  const f = await seedUserOrgProject("xprojorder");
  const ctx = makeAuthContext(f.userId);

  // Seed 5 tasks that share an identical match rank (all substring matches,
  // none are exact / prefix). With only `rankExpr` + `tasks.order` to sort
  // by, two tasks with the same `order` would flip nondeterministically;
  // the `asc(tasks.id)` tie-breaker pins them in place.
  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES
        (${f.projectId}, 'alpha keyword foo', 1, 100),
        (${f.projectId}, 'beta keyword foo',  2, 100),
        (${f.projectId}, 'gamma keyword foo', 3, 100),
        (${f.projectId}, 'delta keyword foo', 4, 100),
        (${f.projectId}, 'epsilon keyword foo', 5, 100)
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const a = await searchTasksAcrossProjects(ctx, "keyword");
  const b = await searchTasksAcrossProjects(ctx, "keyword");
  const c = await searchTasksAcrossProjects(ctx, "keyword");

  expect(a.length).toBe(5);
  expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  expect(a.map((r) => r.id)).toEqual(c.map((r) => r.id));
});

test("listMyTasks returns the cross-project MyTask shape for rows assigned to the caller", async () => {
  const f = await seedUserOrgProject("mytaskshappy");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  let taskId = "";
  try {
    const [row] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "status")
      VALUES (${f.projectId}, 'My assigned task', 1, 1, 'in_progress')
      RETURNING id
    `;
    taskId = row.id;
    await sqlc`
      INSERT INTO task_assignees ("task_id", "user_id")
      VALUES (${taskId}, ${f.userId})
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await listMyTasks(ctx);
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(row.id).toBe(taskId);
  expect(row.title).toBe("My assigned task");
  expect(row.status).toBe("in_progress");
  expect(row.state).toBe("in_progress");
  expect(row.stage).toBe("working");
  expect(row.upstreamCount).toBe(0);
  expect(row.downstreamCount).toBe(0);
  expect(row.blockedBy).toBeNull();
  expect(row.agentActive).toBe(false);
  expect(row.project.id).toBe(f.projectId);
  expect(row.project.identifier.length).toBeGreaterThan(0);
  expect(row.project.color).toMatch(/^hsl\(/);
  expect(row.taskRef).toContain(row.project.identifier);
});

test("listMyTasks excludes tasks in teams the caller is not a member of", async () => {
  const me = await seedUserOrgProject("mytasksisome");
  const other = await seedUserOrgProject("mytasksisoother");
  const ctx = makeAuthContext(me.userId);

  const sqlc = superuserPool();
  try {
    // Foreign-team task that happens to carry MY user-id in task_assignees —
    // the row exists in the DB (seeded with BYPASSRLS); the data function
    // must NOT surface it because my user is not a member of the other team.
    const [foreign] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${other.projectId}, 'Foreign-team task', 1, 1)
      RETURNING id
    `;
    await sqlc`
      INSERT INTO task_assignees ("task_id", "user_id")
      VALUES (${foreign.id}, ${me.userId})
    `;

    // My own assigned task in MY team — should be the only row returned.
    const [mine] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order")
      VALUES (${me.projectId}, 'My own task', 1, 1)
      RETURNING id
    `;
    await sqlc`
      INSERT INTO task_assignees ("task_id", "user_id")
      VALUES (${mine.id}, ${me.userId})
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await listMyTasks(ctx);
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("My own task");
  expect(rows[0].project.id).toBe(me.projectId);
});

test("listMyTasks surfaces blockedBy + upstream count for a planned row with an unmet dep", async () => {
  const f = await seedUserOrgProject("mytasksblocked");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    // Two tasks in the same project; the planned task `target` depends on
    // the in-progress task `block`. listMyTasks should mark target as
    // `state="blocked"`, `blockedBy=<block ref>`, `upstreamCount=1`.
    const [block] = await sqlc<{ id: string; sequence_number: number }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "status")
      VALUES (${f.projectId}, 'Upstream block', 1, 1, 'in_progress')
      RETURNING id, sequence_number
    `;
    const [target] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "status")
      VALUES (${f.projectId}, 'Downstream target', 2, 2, 'planned')
      RETURNING id
    `;
    await sqlc`
      INSERT INTO task_edges ("source_task_id", "target_task_id", "edge_type")
      VALUES (${target.id}, ${block.id}, 'depends_on')
    `;
    await sqlc`
      INSERT INTO task_assignees ("task_id", "user_id")
      VALUES (${target.id}, ${f.userId})
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await listMyTasks(ctx);
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe("Downstream target");
  expect(rows[0].state).toBe("blocked");
  expect(rows[0].stage).toBe("planning");
  expect(rows[0].upstreamCount).toBe(1);
  expect(rows[0].downstreamCount).toBe(0);
  expect(rows[0].blockedBy).toContain(rows[0].project.identifier);
});

test("deriveLifecycleStage covers every state branch", () => {
  expect(deriveLifecycleStage("done", false)).toBe("execution");
  expect(deriveLifecycleStage("in_progress", false)).toBe("working");
  expect(deriveLifecycleStage("in_review", false)).toBe("working");
  expect(deriveLifecycleStage("ready", false)).toBe("planning");
  expect(deriveLifecycleStage("ready", true)).toBe("agent");
  expect(deriveLifecycleStage("plannable", false)).toBe("planning");
  expect(deriveLifecycleStage("blocked", false)).toBe("planning");
  expect(deriveLifecycleStage("draft", false)).toBe("draft");
  expect(deriveLifecycleStage("cancelled", false)).toBe("draft");
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
  const created = await createTask(ctx, {
    projectId: f.projectId,
    title: "T2",
  });

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

  const created = await createTask(ctx, {
    projectId: f.projectId,
    title: "doomed",
  });
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
  const sqlc = superuserPool();
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

  const err = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    assigneeIds: [strangerId],
  }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(ForbiddenError);
  const fe = err as ForbiddenError;
  expect(fe.message).toBe(
    "One or more assignees are not members of this team.",
  );
  expect(fe.resourceId).toBeUndefined();
  expect(fe.message).not.toContain(strangerId);
});

test("updateTask appends assigneeIds by default and replaces with overwriteArrays", async () => {
  const f = await seedUserOrgProject("assignee-modes");
  const ctx = makeAuthContext(f.userId);

  // Add a second member to the same org.
  const sqlc = superuserPool();
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
  const sameText = final.acceptanceCriteria.filter(
    (c) => c.text === "duplicate-X",
  );
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

test("overwriteArrays clears all criteria when called with empty array", async () => {
  const f = await seedUserOrgProject("emptycrit");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    acceptanceCriteria: ["A", "B", "C"],
  });

  const cleared = await updateTask(
    ctx,
    task.id,
    { acceptanceCriteria: [] },
    true,
  );
  expect((cleared.acceptanceCriteria ?? []).length).toBe(0);

  const reread = await getTaskFull(ctx, task.id);
  expect(reread.acceptanceCriteria.length).toBe(0);
});

test("overwriteArrays clears all decisions when called with empty array", async () => {
  const f = await seedUserOrgProject("emptydec");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    decisions: ["First", "Second"],
  });

  const cleared = await updateTask(ctx, task.id, { decisions: [] }, true);
  expect((cleared.decisions ?? []).length).toBe(0);

  const reread = await getTaskFull(ctx, task.id);
  expect(reread.decisions.length).toBe(0);
});

test("single-call dedup collapses same-id and same-text rows in one payload", async () => {
  const f = await seedUserOrgProject("singlecalldedup");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const seeded = await updateTask(ctx, task.id, { acceptanceCriteria: ["X"] });
  const idA = (seeded.acceptanceCriteria ?? [])[0].id;

  // Element 1 collides on id (with new text "Y"); element 2 collides on
  // text "X" (with a fresh id). Both branches of the `id IN OR text IN`
  // DELETE must fire in one statement and resolve to two final rows.
  await updateTask(ctx, task.id, {
    acceptanceCriteria: [
      { id: idA, text: "Y" },
      { id: crypto.randomUUID(), text: "X" },
    ],
  });

  const final = await getTaskFull(ctx, task.id);
  const texts = final.acceptanceCriteria.map((c) => c.text).sort();
  expect(texts).toEqual(["X", "Y"]);
});

test("decisions dedup replaces same-id and same-text entries (mirror of criteria)", async () => {
  const f = await seedUserOrgProject("decdedup");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const seeded = await updateTask(ctx, task.id, {
    decisions: [{ text: "chose X", source: "refinement", date: "2026-01-01" }],
  });
  const idA = (seeded.decisions ?? [])[0].id;

  // Same-id, different text.
  await updateTask(ctx, task.id, {
    decisions: [
      { id: idA, text: "chose Y", source: "review", date: "2026-02-01" },
    ],
  });
  // Same-text, different id — last writer wins on metadata.
  await updateTask(ctx, task.id, {
    decisions: [{ text: "chose Y", source: "review", date: "2026-03-01" }],
  });

  const final = await getTaskFull(ctx, task.id);
  expect(final.decisions.length).toBe(1);
  expect(final.decisions[0].text).toBe("chose Y");
  expect(final.decisions[0].date).toBe("2026-03-01");
});

test("getTaskFull returns criteria in position order, not insertion order", async () => {
  const f = await seedUserOrgProject("ordering");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await updateTask(ctx, task.id, { acceptanceCriteria: ["A", "B", "C", "D"] });

  // Mutate "B"'s position to 99 directly so insertion-order and position-
  // order diverge. getTaskFull must reflect position-order.
  const direct = superuserPool();
  try {
    await direct`
      UPDATE task_acceptance_criteria
      SET position = 99
      WHERE task_id = ${task.id}::uuid AND text = 'B'
    `;
  } finally {
    await direct.end({ timeout: 5 });
  }

  const final = await getTaskFull(ctx, task.id);
  const ordered = final.acceptanceCriteria.map((c) => c.text);
  expect(ordered).toEqual(["A", "C", "D", "B"]);
});

test("getTaskFull ties on position resolve deterministically by id", async () => {
  // Regression guard: positions are presentation-only with no unique
  // constraint; concurrent appends in `applyCriteriaWrite` /
  // `applyDecisionsWrite` can land at the same position. The read path
  // (`fetchTaskFull` and `fetchTaskChildren`) must tie-break by `id` so
  // the row order is stable across calls.
  const f = await seedUserOrgProject("positiontie");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await updateTask(ctx, task.id, { acceptanceCriteria: ["A", "B", "C"] });
  await updateTask(ctx, task.id, { decisions: ["D1", "D2", "D3"] });

  // Force two criteria and two decisions to share a position so the
  // tie-break has actual ties to resolve.
  const direct = superuserPool();
  try {
    await direct`
      UPDATE task_acceptance_criteria SET position = 7
      WHERE task_id = ${task.id}::uuid AND text IN ('A', 'B')
    `;
    await direct`
      UPDATE task_decisions SET position = 9
      WHERE task_id = ${task.id}::uuid AND text IN ('D1', 'D2')
    `;
  } finally {
    await direct.end({ timeout: 5 });
  }

  const first = await getTaskFull(ctx, task.id);
  const second = await getTaskFull(ctx, task.id);
  const third = await getTaskFull(ctx, task.id);

  const critOrder = (r: Awaited<ReturnType<typeof getTaskFull>>) =>
    r.acceptanceCriteria.map((c) => c.id);
  const decOrder = (r: Awaited<ReturnType<typeof getTaskFull>>) =>
    r.decisions.map((d) => d.id);

  expect(critOrder(first)).toEqual(critOrder(second));
  expect(critOrder(second)).toEqual(critOrder(third));
  expect(decOrder(first)).toEqual(decOrder(second));
  expect(decOrder(second)).toEqual(decOrder(third));

  // And the tie-break key must be `id ASC` — the two tied criteria
  // appear in `id` order at the head of the list.
  const tiedCrit = first.acceptanceCriteria
    .filter((c) => c.text === "A" || c.text === "B")
    .map((c) => c.id);
  expect(tiedCrit).toEqual([...tiedCrit].sort());
  const tiedDec = first.decisions
    .filter((d) => d.text === "D1" || d.text === "D2")
    .map((d) => d.id);
  expect(tiedDec).toEqual([...tiedDec].sort());
});

test("updateTask return value carries the freshly-written criteria", async () => {
  const f = await seedUserOrgProject("returnval");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  const result = await updateTask(ctx, task.id, {
    acceptanceCriteria: ["one", "two"],
  });
  expect((result.acceptanceCriteria ?? []).map((c) => c.text).sort()).toEqual([
    "one",
    "two",
  ]);
});

test("foreign key rejects orphan decision insert", async () => {
  await seedUserOrgProject("orphandecision");

  const sqlc = superuserPool();
  try {
    const orphanTaskId = "00000000-0000-0000-0000-000000000003";
    const orphanDecisionId = "00000000-0000-0000-0000-000000000004";
    let threw = false;
    try {
      await sqlc`
        INSERT INTO task_decisions (id, task_id, text, source, decision_date, position)
        VALUES (${orphanDecisionId}::uuid, ${orphanTaskId}::uuid, 'orphan', 'refinement', '2026-01-01', 0)
      `;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  } finally {
    await sqlc.end({ timeout: 5 });
  }
});
