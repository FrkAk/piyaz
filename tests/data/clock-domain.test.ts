import { afterEach, expect, setSystemTime, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { superuserPool } from "@/tests/setup/global";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { applyTaskEdit } from "@/lib/data/task-edit";
import {
  addTaskLink,
  createTask,
  removeTaskLink,
  updateTask,
  updateTaskLink,
} from "@/lib/data/task";
import { createEdge, updateEdge } from "@/lib/data/edge";
import {
  getProjectListMaxUpdatedAt,
  getProjectMaxUpdatedAt,
  renameCategory,
  renameProjectIdentifier,
  updateProject,
} from "@/lib/data/project";
import {
  createNote,
  createNoteTaskLink,
  deleteNote,
  getNotesTreeVersion,
  moveFolder,
  moveNote,
  removeNoteTaskLink,
  requestShare,
  restoreNote,
  updateNote,
} from "@/lib/data/note";
import { clearOrgMembershipArtifacts } from "@/lib/data/account";
import { asIdentifier } from "@/lib/graph/identifier";

/**
 * Clock-domain pins for the conditional-GET validator columns: every
 * `updated_at` / `meta_updated_at` stamp on projects, tasks, task_edges,
 * and notes must come from the database clock (`clock_timestamp()`), never
 * from the app clock. Each writer family runs with the app clock frozen an
 * hour in the past; a leftover JS `new Date()` stamp would land ~3600s
 * behind the database clock and fail the proximity assertion, and the fed
 * validator must still strictly advance across the write.
 */

const APP_CLOCK_LAG_MS = 3_600_000;
const DB_PROXIMITY_S = 120;

/**
 * Run `fn` with the app clock frozen one hour in the past.
 *
 * @param fn - Writer calls to execute under the lagged clock.
 * @returns The callback's result, with the clock restored afterwards.
 */
async function withLaggedClock<T>(fn: () => Promise<T>): Promise<T> {
  setSystemTime(new Date(Date.now() - APP_CLOCK_LAG_MS));
  try {
    return await fn();
  } finally {
    setSystemTime();
  }
}

/**
 * Wait 10ms so `clock_timestamp()` strictly advances past prior stamps.
 *
 * @returns Resolves after the delay.
 */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

/**
 * Read the current database wall clock.
 *
 * @returns Epoch seconds of `now()` on the database.
 */
async function dbNowEpoch(): Promise<number> {
  const su = superuserPool();
  const [row] = await su<{ n: number }[]>`
    SELECT extract(epoch FROM now())::float8 AS n
  `;
  return row.n;
}

/**
 * Read one row's clock columns as epoch seconds via superuser SQL.
 *
 * @param table - One of the four validator tables.
 * @param id - Row UUID.
 * @returns Epoch seconds of `updated_at` (u) and `meta_updated_at` (m).
 */
async function rowClocks(
  table: "projects" | "tasks" | "task_edges" | "notes",
  id: string,
): Promise<{ u: number; m: number }> {
  const su = superuserPool();
  const rows = await su.unsafe<{ u: number; m: number }[]>(
    `SELECT extract(epoch FROM updated_at)::float8 AS u,
            extract(epoch FROM meta_updated_at)::float8 AS m
     FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * Assert a stamp came from the database clock: within the proximity
 * window of database `now()`. An app-clock stamp under the frozen lag
 * would sit a full hour behind.
 *
 * @param stamp - Row clock in epoch seconds.
 * @param dbNow - Database `now()` in epoch seconds, read just before the write.
 */
function expectDbStamp(stamp: number, dbNow: number): void {
  expect(Math.abs(stamp - dbNow)).toBeLessThan(DB_PROXIMITY_S);
}

afterEach(async () => {
  setSystemTime();
  await truncateAll();
});

test("validator clock columns default to clock_timestamp()", async () => {
  const su = superuserPool();
  const rows = await su<{ rel: string; col: string; def: string }[]>`
    SELECT c.relname AS rel, a.attname AS col,
           pg_get_expr(d.adbin, d.adrelid) AS def
    FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('projects', 'tasks', 'task_edges', 'notes')
      AND a.attname IN ('updated_at', 'meta_updated_at')
  `;
  expect(rows).toHaveLength(8);
  for (const row of rows) {
    expect(`${row.rel}.${row.col} ${row.def}`).toBe(
      `${row.rel}.${row.col} clock_timestamp()`,
    );
  }
});

test("task writers stamp the DB clock when the app clock lags", async () => {
  const f = await seedUserOrgProject("clockdom-task");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const before = await getProjectMaxUpdatedAt(ctx, f.projectId, "content");
  await settle();
  const dbNow = await dbNowEpoch();

  await withLaggedClock(async () => {
    await updateTask(ctx, task.id, { description: "updated" });
    await applyTaskEdit(ctx, task.id, [
      { op: "set", field: "priority", value: "core" },
    ]);
    const link = await addTaskLink(ctx, task.id, "https://example.com/a");
    await updateTaskLink(ctx, link.id, "https://example.com/b");
    await removeTaskLink(ctx, link.id);
  });

  const clocks = await rowClocks("tasks", task.id);
  expectDbStamp(clocks.u, dbNow);
  const after = await getProjectMaxUpdatedAt(ctx, f.projectId, "content");
  expect(after.getTime()).toBeGreaterThan(before.getTime());
});

test("edge and project writers stamp the DB clock when the app clock lags", async () => {
  const f = await seedUserOrgProject("clockdom-proj");
  const ctx = makeAuthContext(f.userId);
  const a = await createTask(ctx, { projectId: f.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: f.projectId, title: "B" });
  const edge = await createEdge(ctx, {
    sourceTaskId: a.id,
    targetTaskId: b.id,
    edgeType: "relates_to",
  });
  await updateProject(ctx, f.projectId, { categories: ["old"] });
  await updateTask(ctx, a.id, { category: "old" });
  const beforeMeta = await getProjectMaxUpdatedAt(ctx, f.projectId, "graph");
  const beforeList = await getProjectListMaxUpdatedAt(ctx);
  await settle();
  const dbNow = await dbNowEpoch();

  await withLaggedClock(async () => {
    await updateEdge(ctx, edge.id, { edgeType: "depends_on" });
    await updateProject(ctx, f.projectId, { title: "Renamed" });
    await renameProjectIdentifier(ctx, f.projectId, asIdentifier("CLKD"));
    await renameCategory(ctx, f.projectId, "old", "new");
  });

  const e = await rowClocks("task_edges", edge.id);
  expectDbStamp(e.u, dbNow);
  expectDbStamp(e.m, dbNow);
  const p = await rowClocks("projects", f.projectId);
  expectDbStamp(p.u, dbNow);
  const cascaded = await rowClocks("tasks", a.id);
  expectDbStamp(cascaded.u, dbNow);
  const afterMeta = await getProjectMaxUpdatedAt(ctx, f.projectId, "graph");
  expect(afterMeta.getTime()).toBeGreaterThan(beforeMeta.getTime());
  const afterList = await getProjectListMaxUpdatedAt(ctx);
  expect(afterList.getTime()).toBeGreaterThan(beforeList.getTime());
});

test("note writers stamp the DB clock when the app clock lags", async () => {
  const f = await seedUserOrgProject("clockdom-note");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const note = await createNote(ctx, { projectId: f.projectId, title: "N" });
  const teamNote = await createNote(ctx, {
    projectId: f.projectId,
    title: "Team",
    visibility: "team",
  });
  const beforeTree = await getNotesTreeVersion(ctx, f.projectId);
  await settle();
  const dbNow = await dbNowEpoch();

  await withLaggedClock(async () => {
    await updateNote(ctx, note.id, { title: "N2" });
    await moveNote(ctx, note.id, "docs");
    await moveFolder(ctx, f.projectId, "docs", "", "archive");
    await createNoteTaskLink(ctx, note.id, task.id, "reference");
    await removeNoteTaskLink(ctx, note.id, task.id, "reference");
    await requestShare(ctx, note.id);
    await deleteNote(ctx, note.id);
    await restoreNote(ctx, note.id);
    await updateNote(ctx, teamNote.id, { visibility: "private" });
  });

  const n = await rowClocks("notes", note.id);
  expectDbStamp(n.u, dbNow);
  expectDbStamp(n.m, dbNow);
  const p = await rowClocks("projects", f.projectId);
  expectDbStamp(p.u, dbNow);
  const afterTree = await getNotesTreeVersion(ctx, f.projectId);
  expect(afterTree.maxUpdatedAt?.getTime() ?? 0).toBeGreaterThan(
    beforeTree.maxUpdatedAt?.getTime() ?? 0,
  );
});

test("a primary writer stamp is never floored: a change to a future-dated row still moves the validator", async () => {
  const f = await seedUserOrgProject("clockdom-nofloor");
  const ctx = makeAuthContext(f.userId);
  const su = superuserPool();
  await su`
    UPDATE projects
    SET updated_at = clock_timestamp() + interval '1 hour',
        meta_updated_at = clock_timestamp() + interval '1 hour'
    WHERE id = ${f.projectId}
  `;
  const before = await getProjectMaxUpdatedAt(ctx, f.projectId, "content");
  const beforeMeta = await getProjectMaxUpdatedAt(ctx, f.projectId, "graph");

  await updateProject(ctx, f.projectId, { title: "Changed" });

  const after = await getProjectMaxUpdatedAt(ctx, f.projectId, "content");
  const afterMeta = await getProjectMaxUpdatedAt(ctx, f.projectId, "graph");
  expect(after.getTime()).not.toBe(before.getTime());
  expect(afterMeta.getTime()).not.toBe(beforeMeta.getTime());
});

test("the membership scrub stamps the DB clock when the app clock lags", async () => {
  const f = await seedUserOrgProject("clockdom-scrub", { legalCurrent: false });
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  const su = superuserPool();
  await su`
    INSERT INTO task_assignees ("task_id", "user_id")
    VALUES (${task.id}, ${f.userId})
  `;
  await settle();
  const dbNow = await dbNowEpoch();

  await withLaggedClock(() =>
    clearOrgMembershipArtifacts(f.userId, f.organizationId),
  );

  const clocks = await rowClocks("tasks", task.id);
  expectDbStamp(clocks.u, dbNow);
});
