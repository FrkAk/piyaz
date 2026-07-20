import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedSecondMember, seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import {
  getProjectSlim,
  getProjectGraphSlim,
  getProjectChrome,
  getProjectMaxUpdatedAt,
  getProjectListMaxUpdatedAt,
  getProjectMeta,
  listProjectsSlim,
  listProjectIndex,
  listProjectsForMcp,
  deleteCategory,
  renameCategory,
  renameProjectIdentifier,
  updateProject,
  type ProjectSlimPage,
} from "@/lib/data/project";
import {
  approveShareRequest,
  createNote,
  createNoteTaskLink,
  deleteNote,
  moveNote,
  removeNoteTaskLink,
  restoreNote,
  updateNote,
} from "@/lib/data/note";
import {
  createTask,
  deleteTask,
  getTaskFull,
  updateTask,
} from "@/lib/data/task";
import { applyTaskEdit } from "@/lib/data/task-edit";
import { createEdge, removeEdge, updateEdge } from "@/lib/data/edge";
import { asIdentifier } from "@/lib/graph/identifier";
import { findProjectAccess } from "@/lib/data/access";
import { makeAuthContext } from "@/lib/auth/context";

/**
 * Read both note validator clocks for a project.
 *
 * @param ctx - Resolved auth context.
 * @param projectId - Project UUID.
 * @returns The meta- and content-mode validator timestamps.
 */
async function readNoteClocks(
  ctx: ReturnType<typeof makeAuthContext>,
  projectId: string,
): Promise<{ meta: number; content: number }> {
  const [meta, content] = await Promise.all([
    getProjectMaxUpdatedAt(ctx, projectId, "meta"),
    getProjectMaxUpdatedAt(ctx, projectId, "content"),
  ]);
  return { meta: meta.getTime(), content: content.getTime() };
}

/**
 * Wait 50ms so Postgres clocks strictly advance past prior writes.
 *
 * @returns Resolves after the delay.
 */
function settleClock(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

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
    "description",
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
      "hasExecutionRecord",
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
  expect(g.notes).toEqual([]);
  expect(g.noteLinks).toEqual([]);
  expect(g.noteTaskLinks).toEqual([]);
});

test("getProjectGraphSlim notes payload is RLS-scoped per member", async () => {
  const f = await seedUserOrgProject("graphnotes");
  const userB = await seedSecondMember(f.organizationId, "graphnotes-b");

  const su = superuserPool();
  const [task] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${f.projectId}, 'T1', 1)
    RETURNING id
  `;
  const [teamNote] = await su<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, type, feed_mode, created_by)
    VALUES (${f.projectId}, 'Team', 'team', 'team', 'guidance', 'all', ${f.userId})
    RETURNING id
  `;
  const [privA] = await su<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, created_by)
    VALUES (${f.projectId}, 'Priv A', 'priv-a', 'private', ${f.userId})
    RETURNING id
  `;
  const [privB] = await su<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, created_by)
    VALUES (${f.projectId}, 'Priv B', 'priv-b', 'private', ${userB})
    RETURNING id
  `;
  await su`
    INSERT INTO note_task_links (note_id, task_id, kind) VALUES
      (${teamNote.id}, ${task.id}, 'reference'),
      (${privB.id}, ${task.id}, 'reference')
  `;
  await su`
    INSERT INTO note_links (source_note_id, target_note_id) VALUES
      (${teamNote.id}, ${privB.id}),
      (${teamNote.id}, ${privA.id})
  `;

  const gA = await getProjectGraphSlim(makeAuthContext(f.userId), f.projectId);
  expect(gA.notes.map((n) => n.id).sort()).toEqual(
    [teamNote.id, privA.id].sort(),
  );
  for (const n of gA.notes) {
    expect(Object.keys(n).sort()).toEqual([
      "fed",
      "id",
      "noteRef",
      "title",
      "type",
    ]);
    expect(n.noteRef).toMatch(/^PRJgraphnotes-N\d+$/);
  }
  expect(gA.notes.find((n) => n.id === teamNote.id)?.type).toBe("guidance");
  expect(gA.notes.find((n) => n.id === teamNote.id)?.fed).toBe(true);
  expect(gA.notes.find((n) => n.id === privA.id)?.fed).toBe(false);
  expect(gA.noteTaskLinks).toEqual([
    { noteId: teamNote.id, taskId: task.id, kind: "reference" },
  ]);
  expect(gA.noteLinks).toEqual([
    { sourceNoteId: teamNote.id, targetNoteId: privA.id },
  ]);

  const gB = await getProjectGraphSlim(makeAuthContext(userB), f.projectId);
  expect(gB.notes.map((n) => n.id).sort()).toEqual(
    [teamNote.id, privB.id].sort(),
  );
  expect(gB.noteTaskLinks.map((l) => l.noteId).sort()).toEqual(
    [teamNote.id, privB.id].sort(),
  );
  expect(gB.noteLinks).toEqual([
    { sourceNoteId: teamNote.id, targetNoteId: privB.id },
  ]);
});

test("getProjectGraphSlim excludes trashed notes and their edges", async () => {
  const f = await seedUserOrgProject("graphnotes-trash");
  const su = superuserPool();
  const [task] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${f.projectId}, 'T1', 1)
    RETURNING id
  `;
  const [live] = await su<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, created_by)
    VALUES (${f.projectId}, 'Live', 'live', 'team', ${f.userId})
    RETURNING id
  `;
  const [trashed] = await su<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, created_by, deleted_at)
    VALUES (${f.projectId}, 'Trashed', 'trashed', 'team', ${f.userId}, now())
    RETURNING id
  `;
  await su`
    INSERT INTO note_task_links (note_id, task_id, kind)
    VALUES (${trashed.id}, ${task.id}, 'reference')
  `;
  await su`
    INSERT INTO note_links (source_note_id, target_note_id) VALUES
      (${live.id}, ${trashed.id}),
      (${trashed.id}, ${live.id})
  `;

  const g = await getProjectGraphSlim(makeAuthContext(f.userId), f.projectId);
  expect(g.notes.map((n) => n.id)).toEqual([live.id]);
  expect(g.noteTaskLinks).toEqual([]);
  expect(g.noteLinks).toEqual([]);
});

test("getProjectGraphSlim dedupes note-task pairs to the strongest kind", async () => {
  const f = await seedUserOrgProject("graphnotes-dedupe");
  const su = superuserPool();
  const [task] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${f.projectId}, 'T1', 1)
    RETURNING id
  `;
  const [task2] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${f.projectId}, 'T2', 2)
    RETURNING id
  `;
  const [note] = await su<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, created_by)
    VALUES (${f.projectId}, 'Spec', 'spec', 'team', ${f.userId})
    RETURNING id
  `;
  await su`
    INSERT INTO note_task_links (note_id, task_id, kind) VALUES
      (${note.id}, ${task.id}, 'mention'),
      (${note.id}, ${task.id}, 'spec_of'),
      (${note.id}, ${task2.id}, 'reference'),
      (${note.id}, ${task2.id}, 'mention')
  `;

  const g = await getProjectGraphSlim(makeAuthContext(f.userId), f.projectId);
  const byTask = new Map(g.noteTaskLinks.map((l) => [l.taskId, l]));
  expect(g.noteTaskLinks.length).toBe(2);
  expect(byTask.get(task.id)).toEqual({
    noteId: note.id,
    taskId: task.id,
    kind: "spec_of",
  });
  expect(byTask.get(task2.id)).toEqual({
    noteId: note.id,
    taskId: task2.id,
    kind: "reference",
  });
});

test("note-inclusive validator moves on deliberate link create and remove", async () => {
  const f = await seedUserOrgProject("graphnotes-etag");
  const ctx = makeAuthContext(f.userId);
  const su = superuserPool();
  const [task] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${f.projectId}, 'T1', 1)
    RETURNING id
  `;
  const [note] = await su<{ id: string }[]>`
    INSERT INTO notes (project_id, title, slug, visibility, created_by)
    VALUES (${f.projectId}, 'Ref', 'ref', 'team', ${f.userId})
    RETURNING id
  `;

  const beforeMeta = await getProjectMaxUpdatedAt(ctx, f.projectId, "meta");
  const beforeContent = await getProjectMaxUpdatedAt(
    ctx,
    f.projectId,
    "content",
  );
  await createNoteTaskLink(ctx, note.id, task.id, "reference");
  const afterCreateMeta = await getProjectMaxUpdatedAt(
    ctx,
    f.projectId,
    "meta",
  );
  const afterCreateContent = await getProjectMaxUpdatedAt(
    ctx,
    f.projectId,
    "content",
  );
  expect(afterCreateMeta.getTime()).toBeGreaterThan(beforeMeta.getTime());
  expect(afterCreateContent.getTime()).toBeGreaterThan(beforeContent.getTime());

  await removeNoteTaskLink(ctx, note.id, task.id, "reference");
  const afterRemoveMeta = await getProjectMaxUpdatedAt(
    ctx,
    f.projectId,
    "meta",
  );
  const afterRemoveContent = await getProjectMaxUpdatedAt(
    ctx,
    f.projectId,
    "content",
  );
  expect(afterRemoveMeta.getTime()).toBeGreaterThan(afterCreateMeta.getTime());
  expect(afterRemoveContent.getTime()).toBeGreaterThan(
    afterCreateContent.getTime(),
  );
});

test("body-only note edits move the content clock but not the meta clock", async () => {
  const f = await seedUserOrgProject("graphnotes-body");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Journal",
  });
  await settleClock();

  const before = await readNoteClocks(ctx, f.projectId);
  await updateNote(ctx, note.id, { body: "plain prose, no refs" });
  const after = await readNoteClocks(ctx, f.projectId);

  expect(after.content).toBeGreaterThan(before.content);
  expect(after.meta).toBe(before.meta);
});

test("note metadata edits move the meta clock", async () => {
  const f = await seedUserOrgProject("graphnotes-meta");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Draft",
  });
  await settleClock();

  const before = await readNoteClocks(ctx, f.projectId);
  await updateNote(ctx, note.id, { title: "Renamed" });
  const afterTitle = await readNoteClocks(ctx, f.projectId);
  expect(afterTitle.meta).toBeGreaterThan(before.meta);

  await settleClock();
  await updateNote(ctx, note.id, { feedMode: "all" });
  const afterFeed = await readNoteClocks(ctx, f.projectId);
  expect(afterFeed.meta).toBeGreaterThan(afterTitle.meta);
});

test("folder moves and summary edits move the meta clock", async () => {
  const f = await seedUserOrgProject("graphnotes-metafields");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, { projectId: f.projectId, title: "N" });
  await settleClock();

  const before = await readNoteClocks(ctx, f.projectId);
  await moveNote(ctx, note.id, "docs");
  const afterMove = await readNoteClocks(ctx, f.projectId);
  expect(afterMove.meta).toBeGreaterThan(before.meta);

  await settleClock();
  await updateNote(ctx, note.id, { summary: "one-liner" });
  const afterSummary = await readNoteClocks(ctx, f.projectId);
  expect(afterSummary.meta).toBeGreaterThan(afterMove.meta);
});

test("note trash and restore move the meta clock", async () => {
  const f = await seedUserOrgProject("graphnotes-trashclk");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Doomed",
  });
  await settleClock();

  const before = await readNoteClocks(ctx, f.projectId);
  await deleteNote(ctx, note.id);
  const afterTrash = await readNoteClocks(ctx, f.projectId);
  expect(afterTrash.meta).toBeGreaterThan(before.meta);

  await settleClock();
  await restoreNote(ctx, note.id);
  const afterRestore = await readNoteClocks(ctx, f.projectId);
  expect(afterRestore.meta).toBeGreaterThan(afterTrash.meta);
});

test("body edits move the meta clock only when the derived link set changes", async () => {
  const f = await seedUserOrgProject("graphnotes-derive");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
  });
  await settleClock();

  const before = await readNoteClocks(ctx, f.projectId);
  await updateNote(ctx, note.id, { body: `see [[${task.taskRef}]]` });
  const afterMention = await readNoteClocks(ctx, f.projectId);
  expect(afterMention.meta).toBeGreaterThan(before.meta);

  await settleClock();
  await updateNote(ctx, note.id, {
    body: `see [[${task.taskRef}]] once more`,
  });
  const afterSameSet = await readNoteClocks(ctx, f.projectId);
  expect(afterSameSet.content).toBeGreaterThan(afterMention.content);
  expect(afterSameSet.meta).toBe(afterMention.meta);
});

test("share approval moves the meta clock", async () => {
  const f = await seedUserOrgProject("graphnotes-share");
  const userB = await seedSecondMember(f.organizationId, "graphnotes-share-b");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Pending",
  });
  const su = superuserPool();
  await su`
    UPDATE notes SET share_requested_by = ${userB} WHERE id = ${note.id}
  `;
  await settleClock();

  const before = await readNoteClocks(ctx, f.projectId);
  await approveShareRequest(ctx, note.id);
  const after = await readNoteClocks(ctx, f.projectId);
  expect(after.meta).toBeGreaterThan(before.meta);
});

test("a team-to-private visibility flip moves other members' validators", async () => {
  const f = await seedUserOrgProject("graphnotes-flipclk");
  const userB = await seedSecondMember(f.organizationId, "graphnotes-flip-b");
  const ctxA = makeAuthContext(f.userId);
  const ctxB = makeAuthContext(userB);
  const note = await createNote(ctxA, {
    projectId: f.projectId,
    title: "Was team",
    visibility: "team",
  });
  await settleClock();

  const beforeB = await readNoteClocks(ctxB, f.projectId);
  await updateNote(ctxA, note.id, { visibility: "private" });
  const afterB = await readNoteClocks(ctxB, f.projectId);

  expect(afterB.meta).toBeGreaterThan(beforeB.meta);
  expect(afterB.content).toBeGreaterThan(beforeB.content);
});

test("the flip's project-clock bump never rewinds a future updated_at", async () => {
  const f = await seedUserOrgProject("graphnotes-flipmono");
  const ctxA = makeAuthContext(f.userId);
  const note = await createNote(ctxA, {
    projectId: f.projectId,
    title: "Was team",
    visibility: "team",
  });
  const su = superuserPool();
  await su`
    UPDATE projects SET updated_at = now() + interval '5 seconds'
    WHERE id = ${f.projectId}
  `;
  const [{ updated_at: before }] = await su<{ updated_at: Date }[]>`
    SELECT updated_at FROM projects WHERE id = ${f.projectId}
  `;

  await updateNote(ctxA, note.id, { visibility: "private" });

  const [{ updated_at: after }] = await su<{ updated_at: Date }[]>`
    SELECT updated_at FROM projects WHERE id = ${f.projectId}
  `;
  expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
    new Date(before).getTime(),
  );
});

test("a private-note edit moves only the editor's meta validator", async () => {
  const f = await seedUserOrgProject("graphnotes-privclk");
  const userB = await seedSecondMember(f.organizationId, "graphnotes-priv-b");
  const ctxA = makeAuthContext(f.userId);
  const ctxB = makeAuthContext(userB);
  const noteB = await createNote(ctxB, {
    projectId: f.projectId,
    title: "B private",
  });
  await settleClock();

  const beforeA = await readNoteClocks(ctxA, f.projectId);
  const beforeB = await readNoteClocks(ctxB, f.projectId);
  await updateNote(ctxB, noteB.id, { title: "B renamed" });
  const afterA = await readNoteClocks(ctxA, f.projectId);
  const afterB = await readNoteClocks(ctxB, f.projectId);

  expect(afterB.meta).toBeGreaterThan(beforeB.meta);
  expect(afterA.meta).toBe(beforeA.meta);
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
    inReview: 0,
    inProgress: 1,
    planned: 1,
    draft: 0,
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
    inReview: 0,
    inProgress: 0,
    planned: 0,
    draft: 0,
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

test("getProjectMaxUpdatedAt reads the notes clock selected by notesMode", async () => {
  const f = await seedUserOrgProject("maxnotes");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    // Distinct clocks per column prove each mode reads its own column:
    // meta at +1h, content (updated_at) at +2h.
    const metaFuture = new Date(Date.now() + 3600_000);
    const contentFuture = new Date(Date.now() + 7200_000);
    await sqlc`
      INSERT INTO notes ("project_id", "title", "slug", "visibility", "updated_at", "meta_updated_at")
      VALUES (${f.projectId}, 'Fresh note', 'fresh-note', 'team', ${contentFuture}, ${metaFuture})
    `;
    const none = await getProjectMaxUpdatedAt(ctx, f.projectId);
    expect(none.getTime()).toBeLessThan(metaFuture.getTime() - 1000);

    const meta = await getProjectMaxUpdatedAt(ctx, f.projectId, "meta");
    expect(meta.getTime()).toBeGreaterThanOrEqual(metaFuture.getTime() - 1000);
    expect(meta.getTime()).toBeLessThan(contentFuture.getTime() - 1000);

    const content = await getProjectMaxUpdatedAt(ctx, f.projectId, "content");
    expect(content.getTime()).toBeGreaterThanOrEqual(
      contentFuture.getTime() - 1000,
    );
  } finally {
    await sqlc.end({ timeout: 5 });
  }
});

test("getProjectListMaxUpdatedAt returns the latest updated_at across the caller's accessible scope", async () => {
  // RLS scopes the row sets; the helper aggregates MAX(updated_at) with
  // no piyaz_auth join (app_user has no grant there).
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
    inReview: 0,
    inProgress: 2,
    planned: 0,
    draft: 0,
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

test("listProjectsSlim does not skip rows that share a sub-millisecond timestamp across a page boundary", async () => {
  const f = await seedUserOrgProject("microsec");
  const ctx = makeAuthContext(f.userId);

  const ids: string[] = [];
  const sqlc = superuserPool();
  try {
    await sqlc`DELETE FROM projects WHERE id = ${f.projectId}`;
    for (let i = 0; i < 5; i++) {
      const [r] = await sqlc<{ id: string }[]>`
        INSERT INTO projects ("organization_id", "title", "identifier", "updated_at")
        VALUES (${f.organizationId}, ${"M" + i}, ${"MIC" + i}, '2026-05-07 20:22:32.747123+00')
        RETURNING id
      `;
      ids.push(r.id);
    }
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const page: ProjectSlimPage = await listProjectsSlim(ctx, {
      limit: 2,
      cursor,
    });
    for (const row of page.rows) seen.add(row.id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  expect(seen.size).toBe(5);
  for (const id of ids) expect(seen.has(id)).toBe(true);
});

test("listProjectIndex returns the slim nav shape, newest first", async () => {
  const f = await seedUserOrgProject("index");
  const ctx = makeAuthContext(f.userId);

  const sqlc = superuserPool();
  try {
    for (let i = 0; i < 3; i++) {
      await sqlc`
        INSERT INTO projects ("organization_id", "title", "identifier", "updated_at")
        VALUES (${f.organizationId}, ${"P" + i}, ${"IDX" + i}, ${new Date(Date.now() + (i + 1) * 1000)})
      `;
    }
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const rows = await listProjectIndex(ctx);
  expect(rows.length).toBe(4);
  expect(Object.keys(rows[0]!).sort()).toEqual([
    "id",
    "identifier",
    "organizationId",
    "title",
  ]);
  expect(rows[0]!.identifier).toBe("IDX2");
  expect(rows[rows.length - 1]!.id).toBe(f.projectId);
});

test("listProjectIndex is RLS-scoped to the caller's memberships", async () => {
  const mine = await seedUserOrgProject("index-mine");
  const theirs = await seedUserOrgProject("index-theirs");
  const ctx = makeAuthContext(mine.userId);

  const rows = await listProjectIndex(ctx);
  const ids = new Set(rows.map((r) => r.id));
  expect(ids.has(mine.projectId)).toBe(true);
  expect(ids.has(theirs.projectId)).toBe(false);
});

test("listProjectsForMcp returns the slim agent shape without description, categories, or timestamps", async () => {
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
    inReview: 0,
    inProgress: 2,
    planned: 0,
    draft: 0,
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
      INSERT INTO piyaz_auth."organization" ("name", "slug", "createdAt")
      VALUES ('Empty Team Mcp', 'empty-team-mcp', now())
      RETURNING id
    `;
    await sqlc`
      INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
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

test("findProjectAccess access row omits createdAt", async () => {
  const f = await seedUserOrgProject("access-projection");

  const access = await findProjectAccess(f.userId, f.projectId);

  expect(access).not.toBeNull();
  const keys = Object.keys(access!.project);
  expect(keys).not.toContain("createdAt");
  expect(keys.sort()).toEqual([
    "categories",
    "description",
    "id",
    "identifier",
    "metaUpdatedAt",
    "organizationId",
    "status",
    "title",
    "updatedAt",
  ]);
});

test("graph and chrome reads reject a pre-resolved access row for another project", async () => {
  const a = await seedUserOrgProject("access-mismatch-a");
  const b = await seedUserOrgProject("access-mismatch-b");
  const access = await findProjectAccess(a.userId, a.projectId);
  expect(access).not.toBeNull();

  const ctx = makeAuthContext(a.userId);
  await expect(getProjectGraphSlim(ctx, b.projectId, access!)).rejects.toThrow(
    "pre-resolved access row",
  );
  await expect(getProjectChrome(ctx, b.projectId, access!)).rejects.toThrow(
    "pre-resolved access row",
  );
});

/**
 * Read a task row's meta clock as epoch seconds via superuser.
 *
 * @param taskId - UUID of the task.
 * @returns `meta_updated_at` as a float epoch.
 */
async function taskMetaEpoch(taskId: string): Promise<number> {
  const sqlc = superuserPool();
  try {
    const [row] = await sqlc<{ epoch: number }[]>`
      SELECT extract(epoch FROM meta_updated_at)::float8 AS epoch
      FROM tasks WHERE id = ${taskId}
    `;
    return row.epoch;
  } finally {
    await sqlc.end({ timeout: 5 });
  }
}

test("heavy-only task writes move the content clock but not the meta validator", async () => {
  const f = await seedUserOrgProject("taskmeta-heavy");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "T",
    description: "Body text",
  });
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "executionRecord", value: "initial record" },
  ]);
  await settleClock();
  const before = await readNoteClocks(ctx, f.projectId);

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "implementationPlan", value: "plan body" },
    {
      op: "str_replace",
      field: "description",
      oldStr: "Body text",
      newStr: "Body text v2",
    },
    {
      op: "str_replace",
      field: "executionRecord",
      oldStr: "initial record",
      newStr: "revised record",
    },
    { op: "add", collection: "decisions", text: "Chose X. Cheaper than Y." },
  ]);

  const after = await readNoteClocks(ctx, f.projectId);
  expect(after.content).toBeGreaterThan(before.content);
  expect(after.meta).toBe(before.meta);
});

test("every slim-visible task change moves the meta validator", async () => {
  const f = await seedUserOrgProject("taskmeta-slim");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  let prev = (await readNoteClocks(ctx, f.projectId)).meta;
  const slimEdits: Parameters<typeof applyTaskEdit>[2][] = [
    [{ op: "set", field: "title", value: "T2" }],
    [{ op: "set", field: "status", value: "planned" }],
    [{ op: "set", field: "priority", value: "core" }],
    [{ op: "set", field: "estimate", value: 3 }],
    [{ op: "set", field: "tags", value: ["feature"] }],
    [{ op: "set", field: "category", value: "backend" }],
    [{ op: "set", field: "description", value: "Now present" }],
    [{ op: "set", field: "executionRecord", value: "first record" }],
    [
      {
        op: "add",
        collection: "acceptanceCriteria",
        text: "Renders end to end",
      },
    ],
    [{ op: "add", collection: "assignees", value: "me" }],
  ];
  for (const ops of slimEdits) {
    await settleClock();
    await applyTaskEdit(ctx, task.id, ops);
    const cur = (await readNoteClocks(ctx, f.projectId)).meta;
    expect(cur).toBeGreaterThan(prev);
    prev = cur;
  }

  await settleClock();
  await updateTask(ctx, task.id, { order: 42 });
  const afterOrder = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(afterOrder).toBeGreaterThan(prev);
});

test("criteria and check-state changes that keep the slim payload stable leave the meta validator still", async () => {
  const f = await seedUserOrgProject("taskmeta-stable");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "acceptanceCriteria", text: "First criterion" },
  ]);
  const full = await getTaskFull(ctx, task.id);
  const firstId = full.acceptanceCriteria[0].id;
  await settleClock();
  const before = await readNoteClocks(ctx, f.projectId);

  await applyTaskEdit(ctx, task.id, [
    { op: "add", collection: "acceptanceCriteria", text: "Second criterion" },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "check", collection: "acceptanceCriteria", id: firstId },
  ]);

  const after = await readNoteClocks(ctx, f.projectId);
  expect(after.content).toBeGreaterThan(before.content);
  expect(after.meta).toBe(before.meta);
});

test("edge type changes move the meta validator; note-only edge edits do not", async () => {
  const f = await seedUserOrgProject("edgemeta");
  const ctx = makeAuthContext(f.userId);
  const a = await createTask(ctx, { projectId: f.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: f.projectId, title: "B" });
  await settleClock();
  const beforeCreate = await readNoteClocks(ctx, f.projectId);

  const edge = await createEdge(ctx, {
    sourceTaskId: a.id,
    targetTaskId: b.id,
    edgeType: "relates_to",
  });
  const afterCreate = await readNoteClocks(ctx, f.projectId);
  expect(afterCreate.meta).toBeGreaterThan(beforeCreate.meta);

  await settleClock();
  await updateEdge(ctx, edge.id, { note: "Rewritten note body" });
  const afterNote = await readNoteClocks(ctx, f.projectId);
  expect(afterNote.content).toBeGreaterThan(afterCreate.content);
  expect(afterNote.meta).toBe(afterCreate.meta);

  await settleClock();
  await updateEdge(ctx, edge.id, { edgeType: "depends_on" });
  const afterType = await readNoteClocks(ctx, f.projectId);
  expect(afterType.meta).toBeGreaterThan(afterNote.meta);

  await settleClock();
  await removeEdge(ctx, edge.id);
  const afterRemove = await readNoteClocks(ctx, f.projectId);
  expect(afterRemove.meta).toBeGreaterThan(afterType.meta);
});

test("task deletion moves the meta validator monotonically", async () => {
  const f = await seedUserOrgProject("taskmeta-delete");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, {
    projectId: f.projectId,
    title: "Doomed",
  });
  await settleClock();
  const before = await readNoteClocks(ctx, f.projectId);
  await deleteTask(ctx, task.id);
  const after = await readNoteClocks(ctx, f.projectId);
  expect(after.meta).toBeGreaterThan(before.meta);
});

test("project chrome edits, identifier renames, and category cascades move the meta validator", async () => {
  const f = await seedUserOrgProject("projmeta");
  const ctx = makeAuthContext(f.userId);
  await updateProject(ctx, f.projectId, {
    categories: ["backend", "frontend"],
  });
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "category", value: "backend" },
  ]);
  await settleClock();

  let prev = (await readNoteClocks(ctx, f.projectId)).meta;
  await updateProject(ctx, f.projectId, { title: "Renamed Project" });
  let cur = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(cur).toBeGreaterThan(prev);
  prev = cur;

  await settleClock();
  await renameProjectIdentifier(ctx, f.projectId, asIdentifier("PJX9"));
  cur = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(cur).toBeGreaterThan(prev);
  prev = cur;

  await settleClock();
  const taskMetaBefore = await taskMetaEpoch(task.id);
  await renameCategory(ctx, f.projectId, "backend", "core");
  cur = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(cur).toBeGreaterThan(prev);
  expect(await taskMetaEpoch(task.id)).toBeGreaterThan(taskMetaBefore);
  prev = cur;

  await settleClock();
  const taskMetaBeforeDelete = await taskMetaEpoch(task.id);
  await deleteCategory(ctx, f.projectId, "core");
  cur = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(cur).toBeGreaterThan(prev);
  expect(await taskMetaEpoch(task.id)).toBeGreaterThan(taskMetaBeforeDelete);
});

test("the home-grid list validator still moves on heavy-only task writes", async () => {
  const f = await seedUserOrgProject("listclock-heavy");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await settleClock();
  const before = await getProjectListMaxUpdatedAt(ctx);
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "implementationPlan", value: "plan body" },
  ]);
  const after = await getProjectListMaxUpdatedAt(ctx);
  expect(after.getTime()).toBeGreaterThan(before.getTime());
});

test("updateTask child-driven writes stamp the meta clock via the follow-up branch", async () => {
  const f = await seedUserOrgProject("taskmeta-web");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });

  await settleClock();
  let prev = (await readNoteClocks(ctx, f.projectId)).meta;
  await updateTask(ctx, task.id, { assigneeIds: [f.userId] });
  let cur = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(cur).toBeGreaterThan(prev);
  prev = cur;

  await settleClock();
  await updateTask(ctx, task.id, { acceptanceCriteria: ["First criterion"] });
  cur = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(cur).toBeGreaterThan(prev);

  await settleClock();
  const stable = await readNoteClocks(ctx, f.projectId);
  await updateTask(ctx, task.id, { acceptanceCriteria: ["Second criterion"] });
  const afterAppend = await readNoteClocks(ctx, f.projectId);
  expect(afterAppend.content).toBeGreaterThan(stable.content);
  expect(afterAppend.meta).toBe(stable.meta);

  await settleClock();
  const beforeClear = (await readNoteClocks(ctx, f.projectId)).meta;
  await updateTask(ctx, task.id, { assigneeIds: [] }, true);
  const afterClear = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(afterClear).toBeGreaterThan(beforeClear);
});

test("clearing the executionRecord flips hasExecutionRecord and moves the meta validator", async () => {
  const f = await seedUserOrgProject("taskmeta-clear");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "executionRecord", value: "record body" },
  ]);
  await settleClock();
  const before = (await readNoteClocks(ctx, f.projectId)).meta;
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "executionRecord", value: null },
  ]);
  const after = (await readNoteClocks(ctx, f.projectId)).meta;
  expect(after).toBeGreaterThan(before);
});

test("the slim graph payload sources task and project updatedAt from the meta clocks", async () => {
  const f = await seedUserOrgProject("slimclock");
  const ctx = makeAuthContext(f.userId);
  const sqlc = superuserPool();
  try {
    const contentFuture = new Date(Date.now() + 7200_000);
    const metaPast = new Date(Date.now() - 3600_000);
    const [t] = await sqlc<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "updated_at", "meta_updated_at")
      VALUES (${f.projectId}, 'T', 1, ${contentFuture}, ${metaPast})
      RETURNING id
    `;
    await sqlc`
      UPDATE projects
      SET updated_at = ${contentFuture}, meta_updated_at = ${metaPast}
      WHERE id = ${f.projectId}
    `;

    const g = await getProjectGraphSlim(ctx, f.projectId);

    const task = g.tasks.find((x) => x.id === t.id);
    expect(task?.updatedAt.getTime()).toBe(metaPast.getTime());
    expect(g.project.updatedAt.getTime()).toBe(metaPast.getTime());
  } finally {
    await sqlc.end({ timeout: 5 });
  }
});
