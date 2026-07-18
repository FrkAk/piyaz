import { test, expect, afterEach } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { appUserPool, superuserPool } from "@/tests/setup/global";
import {
  applyFeedBudget,
  createNote,
  decodeFeedRows,
  deleteNote,
  feedFetchLimit,
  getNoteFull,
  getTaskNoteContext,
  resolveExposedNotes,
  updateNote,
  FEED_CHAR_BUDGET,
  FEED_NOTE_CAP,
  FEED_POINTER_CAP,
  type FeedTask,
  type NoteFeedRow,
  type NotePatch,
} from "@/lib/data/note";
import { notesFeedSql } from "@/lib/db/raw/notes-feed";
import { feedSummary } from "@/components/workspace/notes/note-meta";
import { ForbiddenError } from "@/lib/auth/authorization";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

/**
 * Create a team-visible note and patch its feed fields in one step.
 *
 * @param ctx - Auth context of the creator.
 * @param projectId - Target project.
 * @param title - Note title.
 * @param feed - Feed-field patch applied after creation.
 * @returns The updated note summary.
 */
async function seedTeamNote(
  ctx: ReturnType<typeof makeAuthContext>,
  projectId: string,
  title: string,
  feed: Pick<
    NotePatch,
    "feedMode" | "feedCategories" | "feedTags" | "feedTaskIds"
  >,
) {
  const note = await createNote(ctx, {
    projectId,
    title,
    visibility: "team",
  });
  return updateNote(ctx, note.id, feed);
}

/**
 * Insert a live task directly and return its id, for feed-task join tests
 * that need a real row the same-project-live filter will keep.
 *
 * @param projectId - Owning project.
 * @param seq - Per-project sequence number.
 * @returns The new task's id.
 */
async function seedTask(projectId: string, seq: number): Promise<string> {
  const su = superuserPool();
  const [row] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${projectId}, ${`Task ${seq}`}, ${seq})
    RETURNING id
  `;
  return row.id;
}

/**
 * Read a note's `note_feed_tasks` task ids directly, sorted, for asserting
 * the join contents independent of the read path.
 *
 * @param noteId - Note whose join rows are read.
 * @returns Sorted task ids in the note's feed-task join.
 */
async function joinTaskIds(noteId: string): Promise<string[]> {
  const su = superuserPool();
  const rows = await su<{ task_id: string }[]>`
    SELECT task_id FROM note_feed_tasks WHERE note_id = ${noteId}
  `;
  return rows.map((r) => r.task_id).sort();
}

/**
 * Read a note's content and metadata clocks directly.
 *
 * @param noteId - Note whose clocks are read.
 * @returns The note's `updated_at` and `meta_updated_at`.
 */
async function noteClocks(
  noteId: string,
): Promise<{ updatedAt: Date; metaUpdatedAt: Date }> {
  const su = superuserPool();
  const [row] = await su<{ updated_at: Date; meta_updated_at: Date }[]>`
    SELECT updated_at, meta_updated_at FROM notes WHERE id = ${noteId}
  `;
  return { updatedAt: row.updated_at, metaUpdatedAt: row.meta_updated_at };
}

/**
 * Execute a raw feed query as `app_user` with the RLS GUC set, the way the
 * data ring reaches it.
 *
 * @param userId - User whose row access the query runs under.
 * @param query - Feed query to execute.
 * @returns Raw driver rows.
 */
async function runAsAppUser(userId: string, query: SQL): Promise<unknown> {
  const q = new PgDialect().sqlToQuery(query);
  const pool = appUserPool();
  return pool.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return tx.unsafe(q.sql, q.params as string[]);
  });
}

/**
 * Build a synthetic feed row for pure budget tests.
 *
 * @param i - Index folded into id/slug/title.
 * @param summaryChars - Length of the generated summary.
 * @returns A feed row whose char cost is `title.length + summaryChars`.
 */
function makeRow(i: number, summaryChars: number): NoteFeedRow {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    slug: `row-${i}`,
    title: `T${i}`,
    type: "guidance",
    folder: "",
    summary: "s".repeat(summaryChars),
    body: "",
    bodyChars: 0,
    sequenceNumber: i,
    noteRef: `PRJ-N${i}`,
    updatedAt: new Date(Date.now() - i * 1000),
  };
}

/**
 * Build a synthetic guidance row whose char cost is dominated by `body`.
 *
 * @param i - Index folded into id/slug/title.
 * @param bodyChars - Length of the generated body.
 * @returns A guidance feed row with an empty summary.
 */
function makeBodyRow(i: number, bodyChars: number): NoteFeedRow {
  return { ...makeRow(i, 0), body: "b".repeat(bodyChars), bodyChars };
}

test("Notes spec (PYZ-264) §7 truth table: mode arms expose only matching tasks", async () => {
  const f = await seedUserOrgProject("feed1");
  const ctx = makeAuthContext(f.userId);
  const su = superuserPool();
  const [bt] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number", "category", "tags")
    VALUES (${f.projectId}, 'Backend task', 1, 'Backend', ${su.json(["auth", "rls"])})
    RETURNING id
  `;
  const backendTask: FeedTask = {
    id: bt.id,
    category: "Backend",
    tags: ["auth", "rls"],
  };
  const frontendTask: FeedTask = {
    id: crypto.randomUUID(),
    category: "Frontend",
    tags: ["ui"],
  };
  const bareTask: FeedTask = {
    id: crypto.randomUUID(),
    category: null,
    tags: [],
  };

  await seedTeamNote(ctx, f.projectId, "None", { feedMode: "none" });
  await seedTeamNote(ctx, f.projectId, "All", { feedMode: "all" });
  await seedTeamNote(ctx, f.projectId, "Cats", {
    feedMode: "categories",
    feedCategories: ["Backend"],
  });
  await seedTeamNote(ctx, f.projectId, "Tags", {
    feedMode: "tags",
    feedTags: ["rls", "x"],
  });
  await seedTeamNote(ctx, f.projectId, "Tasks", {
    feedMode: "tasks",
    feedTaskIds: [backendTask.id],
  });
  await seedTeamNote(ctx, f.projectId, "EmptyCats", {
    feedMode: "categories",
    feedCategories: [],
  });

  const forBackend = await resolveExposedNotes(ctx, f.projectId, backendTask);
  expect(forBackend.notes.map((n) => n.title).sort()).toEqual([
    "All",
    "Cats",
    "Tags",
    "Tasks",
  ]);
  expect(forBackend.overflow).toEqual([]);

  const forFrontend = await resolveExposedNotes(ctx, f.projectId, frontendTask);
  expect(forFrontend.notes.map((n) => n.title)).toEqual(["All"]);

  const forBare = await resolveExposedNotes(ctx, f.projectId, bareTask);
  expect(forBare.notes.map((n) => n.title)).toEqual(["All"]);
});

test("case-canonical matching: mixed-case labels, whitespace-padded task values, and uppercase feed task ids still match", async () => {
  const f = await seedUserOrgProject("feed7");
  const ctx = makeAuthContext(f.userId);
  const su = superuserPool();
  const [tk] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${f.projectId}, 'Upper task', 1)
    RETURNING id
  `;
  const task: FeedTask = {
    id: tk.id,
    category: " Backend ",
    tags: [" RLS "],
  };

  await seedTeamNote(ctx, f.projectId, "MixedCats", {
    feedMode: "categories",
    feedCategories: [" BACKEND "],
  });
  await seedTeamNote(ctx, f.projectId, "MixedTags", {
    feedMode: "tags",
    feedTags: ["Rls"],
  });
  await seedTeamNote(ctx, f.projectId, "UpperTaskId", {
    feedMode: "tasks",
    feedTaskIds: [task.id.toUpperCase()],
  });

  const res = await resolveExposedNotes(ctx, f.projectId, task);
  expect(res.notes.map((n) => n.title).sort()).toEqual([
    "MixedCats",
    "MixedTags",
    "UpperTaskId",
  ]);
});

test("canonicalization drops empty labels and collapses duplicates on write", async () => {
  const f = await seedUserOrgProject("feed9");
  const ctx = makeAuthContext(f.userId);

  const note = await seedTeamNote(ctx, f.projectId, "Dirty", {
    feedMode: "tags",
    feedTags: ["Auth", " auth ", "  ", "rls"],
  });

  const su = superuserPool();
  const [row] = await su`
    SELECT feed_tags FROM notes WHERE id = ${note.id}
  `;
  expect(row.feed_tags).toEqual(["auth", "rls"]);
});

test("private note with feed_mode='all' stays hidden from its own creator's agent", async () => {
  const f = await seedUserOrgProject("feed2");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Private guidance",
    visibility: "private",
  });
  await updateNote(ctx, note.id, { feedMode: "all" });

  const res = await resolveExposedNotes(ctx, f.projectId, task);
  expect(res.notes).toEqual([]);
  expect(res.overflow).toEqual([]);
});

test("trashed notes and foreign projects never resolve", async () => {
  const f1 = await seedUserOrgProject("feed3a");
  const f2 = await seedUserOrgProject("feed3b");
  const ctx1 = makeAuthContext(f1.userId);
  const ctx2 = makeAuthContext(f2.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };

  const mine = await seedTeamNote(ctx1, f1.projectId, "Mine", {
    feedMode: "all",
  });
  await seedTeamNote(ctx2, f2.projectId, "Elsewhere", { feedMode: "all" });

  const before = await resolveExposedNotes(ctx1, f1.projectId, task);
  expect(before.notes.map((n) => n.title)).toEqual(["Mine"]);

  await deleteNote(ctx1, mine.id);
  const after = await resolveExposedNotes(ctx1, f1.projectId, task);
  expect(after.notes).toEqual([]);

  await expect(
    resolveExposedNotes(ctx1, f2.projectId, task),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("note cap: first 8 by updatedAt DESC admit, remainder degrade to pointers", async () => {
  const f = await seedUserOrgProject("feed4");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };

  const summaries = [];
  for (let i = 0; i < 10; i++) {
    summaries.push(
      await seedTeamNote(ctx, f.projectId, `Doc ${i}`, { feedMode: "all" }),
    );
  }
  const expectedOrder = [...summaries]
    .sort(
      (a, b) =>
        b.updatedAt.getTime() - a.updatedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((s) => s.id);

  const res = await resolveExposedNotes(ctx, f.projectId, task);
  expect(res.notes.length).toBe(FEED_NOTE_CAP);
  expect(res.overflow.length).toBe(2);
  expect([
    ...res.notes.map((n) => n.id),
    ...res.overflow.map((p) => p.id),
  ]).toEqual(expectedOrder);
  for (const pointer of res.overflow) {
    expect(Object.keys(pointer).sort()).toEqual([
      "id",
      "noteRef",
      "sequenceNumber",
      "slug",
      "title",
      "type",
    ]);
  }
});

test("feed rows and overflow pointers carry composed note refs", async () => {
  const f = await seedUserOrgProject("feedN");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };

  for (let i = 0; i < FEED_NOTE_CAP + 2; i++) {
    await seedTeamNote(ctx, f.projectId, `Doc ${i}`, { feedMode: "all" });
  }

  const res = await resolveExposedNotes(ctx, f.projectId, task);
  expect(res.notes.length).toBe(FEED_NOTE_CAP);
  for (const row of res.notes) {
    expect(row.sequenceNumber).toBeGreaterThan(0);
    expect(row.noteRef).toBe(`PRJfeedN-N${row.sequenceNumber}`);
  }
  expect(res.overflow.length).toBe(2);
  for (const pointer of res.overflow) {
    expect(pointer.noteRef).toBe(`PRJfeedN-N${pointer.sequenceNumber}`);
  }
});

test("bodies variant ships guidance bodies only, slim ships none", async () => {
  const f = await seedUserOrgProject("feedG");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };

  await createNote(ctx, {
    projectId: f.projectId,
    title: "Ref",
    visibility: "team",
    type: "reference",
    body: "reference-body-payload",
    feedMode: "all",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Guide",
    visibility: "team",
    type: "guidance",
    body: "guidance-body-payload",
    feedMode: "all",
  });

  const pool = appUserPool();
  const q = new PgDialect().sqlToQuery(
    notesFeedSql(f.projectId, task, FEED_NOTE_CAP, FEED_NOTE_CAP + 1, {
      rankCap: FEED_NOTE_CAP,
      charBound: FEED_CHAR_BUDGET + 1,
      budget: FEED_CHAR_BUDGET,
    }),
  );
  const deep = await pool.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${f.userId}, true)`;
    return tx.unsafe(q.sql, q.params as string[]);
  });
  const byTitle = new Map(deep.map((r) => [r.title, r]));
  expect(byTitle.get("Guide")?.body).toBe("guidance-body-payload");
  expect(byTitle.get("Ref")?.body).toBe("");

  const slim = await resolveExposedNotes(ctx, f.projectId, task);
  expect(slim.notes.every((n) => n.body === "")).toBe(true);
});

test("running-sum egress bound: an over-budget guidance body blanks later bodies", async () => {
  const f = await seedUserOrgProject("feedEgress");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };

  // "Small" is created first (older), "Huge" second (newer). Exposure order
  // is updated_at DESC, so Huge ranks first and its LEFT-bounded body alone
  // exhausts the budget, blanking Small's body server-side.
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Small",
    visibility: "team",
    type: "guidance",
    body: "small-guidance-body",
    feedMode: "all",
  });
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Huge",
    visibility: "team",
    type: "guidance",
    body: "word ".repeat((FEED_CHAR_BUDGET + 500) / 5),
    feedMode: "all",
  });

  const q = new PgDialect().sqlToQuery(
    notesFeedSql(f.projectId, task, FEED_NOTE_CAP, FEED_NOTE_CAP + 1, {
      rankCap: FEED_NOTE_CAP,
      charBound: FEED_CHAR_BUDGET + 1,
      budget: FEED_CHAR_BUDGET,
    }),
  );
  const rows = await appUserPool().begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${f.userId}, true)`;
    return tx.unsafe(q.sql, q.params as string[]);
  });
  const byTitle = new Map(rows.map((r) => [r.title, r]));
  expect(byTitle.get("Huge")?.body.length).toBe(FEED_CHAR_BUDGET + 1);
  expect(byTitle.get("Small")?.body).toBe("");

  // The resolver degrades the over-budget Huge body to a pointer, and Small
  // never had a body to render, so no guidance renders full-body.
  const res = await resolveExposedNotes(ctx, f.projectId, task, undefined);
  const huge = res.notes.find((n) => n.title === "Huge");
  expect(huge?.body ?? "").toBe("");
});

test("budget counts codepoints, not UTF-16 units, for astral bodies", () => {
  const emoji = "😀"; // 1 codepoint, 2 UTF-16 units
  const withinBudget = makeBodyRow(1, 0);
  withinBudget.body = emoji.repeat(FEED_CHAR_BUDGET - 10);
  const res = applyFeedBudget([withinBudget], { maxChars: FEED_CHAR_BUDGET });
  expect(res.notes.length).toBe(1);
  expect(res.notes[0].body).toBe(withinBudget.body);
});

test("applyFeedBudget counts body chars toward the char budget", () => {
  const over = applyFeedBudget(
    [makeBodyRow(1, FEED_CHAR_BUDGET + 1), makeBodyRow(2, 10)],
    { maxChars: FEED_CHAR_BUDGET },
  );
  expect(over.notes).toEqual([]);
  expect(over.overflow.length).toBe(2);

  const fits = applyFeedBudget([makeBodyRow(1, 100), makeRow(2, 100)], {
    maxChars: 300,
  });
  expect(fits.notes.length).toBe(2);
});

test("decodeFeedRows enforces the sentinel fetch bound", () => {
  const raw = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      slug: `raw-${i}`,
      title: `T${i}`,
      type: "guidance",
      folder: "",
      summary: "",
      sequence_number: i + 1,
      identifier: "PRJ",
      updated_at: "2026-07-09T00:00:00.000Z",
    }));

  const limit = feedFetchLimit();
  const truncated = decodeFeedRows(raw(limit + 1));
  expect(truncated.truncated).toBe(true);
  expect(truncated.notes.length + truncated.overflow.length).toBe(limit);

  const exact = decodeFeedRows(raw(limit));
  expect(exact.truncated).toBe(false);
  expect(exact.notes[0].noteRef).toBe("PRJ-N1");
});

test("applyFeedBudget: strict prefix semantics on the char budget", () => {
  const exactFit = applyFeedBudget([makeRow(1, 3998), makeRow(2, 3998)], {
    maxChars: FEED_CHAR_BUDGET,
  });
  expect(exactFit.notes.length).toBe(2);
  expect(exactFit.overflow.length).toBe(0);

  const prefixStops = applyFeedBudget(
    [makeRow(1, 5000), makeRow(2, 5000), makeRow(3, 10)],
    { maxChars: 8000 },
  );
  expect(prefixStops.notes.map((n) => n.slug)).toEqual(["row-1"]);
  expect(prefixStops.overflow.map((p) => p.slug)).toEqual(["row-2", "row-3"]);

  const firstTooBig = applyFeedBudget([makeRow(1, 9000), makeRow(2, 10)], {
    maxChars: 8000,
  });
  expect(firstTooBig.notes).toEqual([]);
  expect(firstTooBig.overflow.length).toBe(2);

  const bothBinding = applyFeedBudget(
    [makeRow(1, 10), makeRow(2, 10), makeRow(3, 10)],
    { maxNotes: 2, maxChars: 8000 },
  );
  expect(bothBinding.notes.length).toBe(2);
  expect(bothBinding.overflow.map((p) => p.slug)).toEqual(["row-3"]);
});

test("applyFeedBudget clamps caller budgets to [1, default]", () => {
  const rows = [makeRow(1, 10), makeRow(2, 10)];

  const floorNotes = applyFeedBudget(rows, { maxNotes: 0 });
  expect(floorNotes.notes.length).toBe(1);
  expect(floorNotes.overflow.length).toBe(1);

  const floorChars = applyFeedBudget(rows, { maxChars: -1 });
  expect(floorChars.notes).toEqual([]);
  expect(floorChars.overflow.length).toBe(2);

  const ceiling = applyFeedBudget(
    Array.from({ length: FEED_NOTE_CAP + 4 }, (_, i) => makeRow(i, 10)),
    { maxNotes: 100 },
  );
  expect(ceiling.notes.length).toBe(FEED_NOTE_CAP);
});

test("overflow pointers cap at FEED_POINTER_CAP with truncation flagged", () => {
  const rows = Array.from(
    { length: FEED_NOTE_CAP + FEED_POINTER_CAP + 5 },
    (_, i) => makeRow(i, 10),
  );

  const res = applyFeedBudget(rows);
  expect(res.notes.length).toBe(FEED_NOTE_CAP);
  expect(res.overflow.length).toBe(FEED_POINTER_CAP);
  expect(res.truncated).toBe(true);

  const small = applyFeedBudget(rows.slice(0, 3));
  expect(small.notes.length).toBe(3);
  expect(small.truncated).toBe(false);
});

test("SQL fetch bound: resolution truncates past maxNotes + FEED_POINTER_CAP", async () => {
  const f = await seedUserOrgProject("feed8");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };
  const su = superuserPool();
  await su`
    INSERT INTO notes (project_id, title, slug, visibility, feed_mode)
    SELECT ${f.projectId}, 'Bulk ' || g, 'bulk-' || g, 'team', 'all'
    FROM generate_series(1, ${1 + FEED_POINTER_CAP + 1}) g
  `;

  const res = await resolveExposedNotes(ctx, f.projectId, task, {
    maxNotes: 1,
  });
  expect(res.notes.length).toBe(1);
  expect(res.overflow.length).toBe(FEED_POINTER_CAP);
  expect(res.truncated).toBe(true);

  await su`
    DELETE FROM notes
    WHERE project_id = ${f.projectId}
      AND slug = ${`bulk-${1 + FEED_POINTER_CAP + 1}`}
  `;
  const exact = await resolveExposedNotes(ctx, f.projectId, task, {
    maxNotes: 1,
  });
  expect(exact.notes.length).toBe(1);
  expect(exact.overflow.length).toBe(FEED_POINTER_CAP);
  expect(exact.truncated).toBe(false);
});

test("summary egress: rows past the note cap return an empty summary", async () => {
  const f = await seedUserOrgProject("feed10");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };

  for (let i = 0; i < 3; i++) {
    const note = await createNote(ctx, {
      projectId: f.projectId,
      title: `S${i}`,
      visibility: "team",
      summary: "payload",
    });
    await updateNote(ctx, note.id, { feedMode: "all" });
  }

  const q = new PgDialect().sqlToQuery(notesFeedSql(f.projectId, task, 1, 3));
  const pool = appUserPool();
  const rows = await pool.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${f.userId}, true)`;
    return tx.unsafe(q.sql, q.params as string[]);
  });
  expect(rows.length).toBe(3);
  expect(rows.map((r) => r.summary)).toEqual(["payload", "", ""]);
});

test("the CTE feed source resolves identically to the bound source", async () => {
  const f = await seedUserOrgProject("feed-cte");
  const ctx = makeAuthContext(f.userId);
  const sql = superuserPool();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number", "category", "tags")
    VALUES (${f.projectId}, 'CTE parity', 1, 'Backend', ${sql.json(["Alpha", "beta"])})
    RETURNING id
  `;
  const taskId = row.id;

  await seedTeamNote(ctx, f.projectId, "by category", {
    feedMode: "categories",
    feedCategories: ["backend"],
  });
  await seedTeamNote(ctx, f.projectId, "by tag", {
    feedMode: "tags",
    feedTags: ["alpha"],
  });
  await seedTeamNote(ctx, f.projectId, "by task", {
    feedMode: "tasks",
    feedTaskIds: [taskId],
  });
  await seedTeamNote(ctx, f.projectId, "by all", { feedMode: "all" });
  await seedTeamNote(ctx, f.projectId, "unmatched", {
    feedMode: "tags",
    feedTags: ["gamma"],
  });

  const task: FeedTask = {
    id: taskId,
    category: "Backend",
    tags: ["Alpha", "beta"],
  };
  const bound = await resolveExposedNotes(ctx, f.projectId, task);
  const cte = (await getTaskNoteContext(ctx, taskId, true)).feed;

  expect(bound.notes.map((n) => n.id).sort()).toEqual(
    cte.notes.map((n) => n.id).sort(),
  );
  expect(cte.notes.length).toBe(4);
  expect(bound.overflow.map((p) => p.id)).toEqual(
    cte.overflow.map((p) => p.id),
  );
});

test("the lengthsOnly feed variant admits the same rows without shipping bodies", async () => {
  const f = await seedUserOrgProject("feed-lengths");
  const ctx = makeAuthContext(f.userId);
  const sql = superuserPool();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${f.projectId}, 'Lengths', 1)
    RETURNING id
  `;

  const half = "g".repeat(Math.floor(FEED_CHAR_BUDGET * 0.6));
  for (const title of ["G1", "G2"]) {
    const note = await createNote(ctx, {
      projectId: f.projectId,
      title,
      visibility: "team",
      type: "guidance",
      body: half,
    });
    await updateNote(ctx, note.id, { feedMode: "all" });
  }

  const bodies = {
    rankCap: FEED_NOTE_CAP,
    charBound: FEED_CHAR_BUDGET + 1,
    budget: FEED_CHAR_BUDGET,
  };
  const fullRaw = await runAsAppUser(
    f.userId,
    notesFeedSql(
      f.projectId,
      { id: row.id, category: null, tags: [] },
      FEED_NOTE_CAP,
      feedFetchLimit() + 1,
      bodies,
    ),
  );
  const full = decodeFeedRows(fullRaw);
  const lengths = (await getTaskNoteContext(ctx, row.id, true)).feed;

  expect(full.notes.map((n) => n.id)).toEqual(lengths.notes.map((n) => n.id));
  expect(full.overflow.map((p) => p.id)).toEqual(
    lengths.overflow.map((p) => p.id),
  );
  expect(lengths.notes.length).toBe(1);
  expect(lengths.overflow.length).toBe(1);

  expect(full.notes[0].body).toBe(half);
  expect(lengths.notes[0].body).toBe("");
  expect(lengths.notes[0].bodyChars).toBe(half.length);
});

test("char budget cuts a DB-backed resolution mid-list", async () => {
  const f = await seedUserOrgProject("feed5");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = { id: crypto.randomUUID(), category: null, tags: [] };

  for (let i = 0; i < 4; i++) {
    const note = await createNote(ctx, {
      projectId: f.projectId,
      title: `N${i}`,
      visibility: "team",
      summary: "x".repeat(200),
    });
    await updateNote(ctx, note.id, { feedMode: "all" });
  }

  const res = await resolveExposedNotes(ctx, f.projectId, task, {
    maxChars: 450,
  });
  expect(res.notes.length).toBe(2);
  expect(res.overflow.length).toBe(2);
});

test("exposure query is index-backed via notes_feed_idx and stays slim", async () => {
  const f = await seedUserOrgProject("feed6");
  const ctx = makeAuthContext(f.userId);
  const task: FeedTask = {
    id: crypto.randomUUID(),
    category: "Backend",
    tags: ["rls"],
  };
  await seedTeamNote(ctx, f.projectId, "Indexed", { feedMode: "all" });
  const su = superuserPool();
  await su`
    INSERT INTO notes (project_id, title, slug, visibility, feed_mode)
    SELECT ${f.projectId}, 'Filler ' || g, 'filler-' || g, 'team', 'none'
    FROM generate_series(1, 400) g
  `;
  await su`ANALYZE notes`;

  const q = new PgDialect().sqlToQuery(
    notesFeedSql(
      f.projectId,
      task,
      FEED_NOTE_CAP,
      FEED_NOTE_CAP + FEED_POINTER_CAP + 1,
    ),
  );
  expect(q.sql).toContain("feed_mode <> 'none'");
  expect(q.sql).toContain("visibility = 'team'");
  expect(q.sql).toContain("LIMIT");
  expect(q.sql).not.toContain("body");
  expect(q.sql).not.toContain("search_tsv");

  const pool = appUserPool();
  const planText = await pool.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${f.userId}, true)`;
    await tx.unsafe("SET LOCAL enable_seqscan = off");
    const rows = await tx.unsafe(
      "EXPLAIN (FORMAT TEXT) " + q.sql,
      q.params as string[],
    );
    return rows.map((r) => Object.values(r)[0]).join("\n");
  });
  expect(planText).toMatch(/notes_feed_idx/);
});

test("deleting a task cascades its note_feed_tasks rows; count and chips stay agreed", async () => {
  const f = await seedUserOrgProject("feedJoinA");
  const ctx = makeAuthContext(f.userId);
  const t1 = await seedTask(f.projectId, 1);
  const t2 = await seedTask(f.projectId, 2);

  const note = await seedTeamNote(ctx, f.projectId, "Selected", {
    feedMode: "tasks",
    feedTaskIds: [t1, t2],
  });
  expect(await joinTaskIds(note.id)).toEqual([t1, t2].sort());

  const before = await getNoteFull(ctx, note.id);
  expect([...before.note.feedTaskIds].sort()).toEqual([t1, t2].sort());
  expect(feedSummary(before.note)).toBe("2 selected tasks");

  await superuserPool()`DELETE FROM tasks WHERE id = ${t1}`;

  expect(await joinTaskIds(note.id)).toEqual([t2]);
  const after = await getNoteFull(ctx, note.id);
  expect(after.note.feedTaskIds).toEqual([t2]);
  expect(feedSummary(after.note)).toBe("1 selected task");

  const forDeleted = await resolveExposedNotes(ctx, f.projectId, {
    id: t1,
    category: null,
    tags: [],
  });
  expect(forDeleted.notes).toEqual([]);
  const forKept = await resolveExposedNotes(ctx, f.projectId, {
    id: t2,
    category: null,
    tags: [],
  });
  expect(forKept.notes.map((n) => n.id)).toEqual([note.id]);
});

test("feed_mode='tasks' exposure derives from the join and stops when the row is removed", async () => {
  const f = await seedUserOrgProject("feedJoinB");
  const ctx = makeAuthContext(f.userId);
  const t1 = await seedTask(f.projectId, 1);
  const task: FeedTask = { id: t1, category: null, tags: [] };

  const note = await seedTeamNote(ctx, f.projectId, "Targeted", {
    feedMode: "tasks",
    feedTaskIds: [t1],
  });

  const injected = await resolveExposedNotes(ctx, f.projectId, task);
  expect(injected.notes.map((n) => n.id)).toEqual([note.id]);

  await updateNote(ctx, note.id, { feedTaskIds: [] });
  const afterClear = await resolveExposedNotes(ctx, f.projectId, task);
  expect(afterClear.notes).toEqual([]);
});

test("editing only feedTaskIds bumps updated_at and meta_updated_at and is not a no-op", async () => {
  const f = await seedUserOrgProject("feedJoinC");
  const ctx = makeAuthContext(f.userId);
  const t1 = await seedTask(f.projectId, 1);
  const note = await seedTeamNote(ctx, f.projectId, "Clocks", {
    feedMode: "tasks",
  });

  const before = await noteClocks(note.id);
  await updateNote(ctx, note.id, { feedTaskIds: [t1] });
  const afterSet = await noteClocks(note.id);
  expect(afterSet.updatedAt.getTime()).toBeGreaterThan(
    before.updatedAt.getTime(),
  );
  expect(afterSet.metaUpdatedAt.getTime()).toBeGreaterThan(
    before.metaUpdatedAt.getTime(),
  );

  await updateNote(ctx, note.id, { feedTaskIds: [t1] });
  const afterNoop = await noteClocks(note.id);
  expect(afterNoop.updatedAt.getTime()).toBe(afterSet.updatedAt.getTime());
});

test("writing dangling or cross-project feed task ids drops them silently", async () => {
  const home = await seedUserOrgProject("feedJoinD1");
  const foreign = await seedUserOrgProject("feedJoinD2");
  const ctx = makeAuthContext(home.userId);
  const live = await seedTask(home.projectId, 1);
  const crossProject = await seedTask(foreign.projectId, 1);
  const dangling = crypto.randomUUID();

  const note = await seedTeamNote(ctx, home.projectId, "Filtered", {
    feedMode: "tasks",
    feedTaskIds: [live, crossProject, dangling],
  });

  expect(await joinTaskIds(note.id)).toEqual([live]);
  expect((await getNoteFull(ctx, note.id)).note.feedTaskIds).toEqual([live]);
});
