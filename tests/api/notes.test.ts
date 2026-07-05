import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { createNote } from "@/lib/data/note";
import { makeAuthContext } from "@/lib/auth/context";
import {
  GET as listGET,
  HEAD as listHEAD,
} from "@/app/api/project/[projectId]/notes/route";
import { GET as noteGET } from "@/app/api/note/[noteId]/route";
import { GET as searchGET } from "@/app/api/project/[projectId]/notes/search/route";
import { GET as backlinksGET } from "@/app/api/task/[taskId]/notes/route";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  await truncateAll();
});

/**
 * Run raw SQL against the test DB as superuser and close the pool.
 *
 * @param fn - Callback receiving the pooled sql tag.
 * @returns The callback's result.
 */
async function su<T>(
  fn: (sql: ReturnType<typeof superuserPool>) => Promise<T>,
): Promise<T> {
  const sql = superuserPool();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Insert a task into a seeded project.
 *
 * @param projectId - Target project id.
 * @param suffix - Title suffix so fixtures don't collide.
 * @returns The new task's id.
 */
async function addTask(projectId: string, suffix: string): Promise<string> {
  return su(async (sql) => {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number")
      VALUES (${projectId}, ${"Task " + suffix}, 1)
      RETURNING id
    `;
    return t.id;
  });
}

/**
 * Link a note to a task with the given kind.
 *
 * @param noteId - Source note id.
 * @param taskId - Target task id.
 * @param kind - Link kind.
 */
async function linkNoteTask(
  noteId: string,
  taskId: string,
  kind: string,
): Promise<void> {
  await su(async (sql) => {
    await sql`
      INSERT INTO note_task_links ("note_id", "task_id", "kind")
      VALUES (${noteId}, ${taskId}, ${kind})
    `;
  });
}

/**
 * Soft-delete a note by setting `deleted_at`.
 *
 * @param noteId - Note to trash.
 */
async function trashNote(noteId: string): Promise<void> {
  await su(async (sql) => {
    await sql`UPDATE notes SET deleted_at = now() WHERE id = ${noteId}`;
  });
}

/** GET request against a route path. */
function get(path: string, headers?: Record<string, string>): Request {
  return new Request(`http://test${path}`, { headers });
}

test("GET /api/project/[id]/notes — slim rows without body, ETag set; 304 + HEAD replay", async () => {
  const f = await seedUserOrgProject("notes-list");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Alpha",
    body: "secret body",
  });
  await createNote(ctx, { projectId: f.projectId, title: "Beta" });
  setSession({ user: { id: f.userId } });

  const params = Promise.resolve({ projectId: f.projectId });
  const res = await listGET(get(`/api/project/${f.projectId}/notes`), {
    params,
  });
  expect(res.status).toBe(200);
  const etag = res.headers.get("etag");
  expect(etag).toBeTruthy();
  const rows = (await res.json()) as Record<string, unknown>[];
  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(row).not.toHaveProperty("body");
    expect(row).toHaveProperty("summary");
  }

  const replay = await listGET(
    get(`/api/project/${f.projectId}/notes`, { "if-none-match": etag! }),
    { params: Promise.resolve({ projectId: f.projectId }) },
  );
  expect(replay.status).toBe(304);
  expect(await replay.text()).toBe("");

  const head = await listHEAD(
    new Request(`http://test/api/project/${f.projectId}/notes`, {
      method: "HEAD",
    }),
    { params: Promise.resolve({ projectId: f.projectId }) },
  );
  expect(head.status).toBe(200);
  expect(head.headers.get("etag")).toBe(etag);
  expect(await head.text()).toBe("");
});

test("GET /api/project/[id]/notes — soft delete below MAX still invalidates the ETag", async () => {
  const f = await seedUserOrgProject("notes-inval");
  const ctx = makeAuthContext(f.userId);
  const older = await createNote(ctx, {
    projectId: f.projectId,
    title: "Older",
  });
  await createNote(ctx, { projectId: f.projectId, title: "Newer" });
  await su(async (sql) => {
    await sql`UPDATE notes SET updated_at = now() - interval '1 hour' WHERE id = ${older.id}`;
  });
  setSession({ user: { id: f.userId } });

  const first = await listGET(get(`/api/project/${f.projectId}/notes`), {
    params: Promise.resolve({ projectId: f.projectId }),
  });
  const etag1 = first.headers.get("etag");

  await trashNote(older.id);

  const second = await listGET(
    get(`/api/project/${f.projectId}/notes`, { "if-none-match": etag1! }),
    { params: Promise.resolve({ projectId: f.projectId }) },
  );
  expect(second.status).toBe(200);
  expect(second.headers.get("etag")).not.toBe(etag1);
  expect(((await second.json()) as unknown[]).length).toBe(1);
});

test('GET /api/project/[id]/notes — empty project yields stable "0-0" validator', async () => {
  const f = await seedUserOrgProject("notes-empty");
  setSession({ user: { id: f.userId } });

  const res = await listGET(get(`/api/project/${f.projectId}/notes`), {
    params: Promise.resolve({ projectId: f.projectId }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
  expect(res.headers.get("etag")).toBe('"0-0"');

  const replay = await listGET(
    get(`/api/project/${f.projectId}/notes`, { "if-none-match": '"0-0"' }),
    { params: Promise.resolve({ projectId: f.projectId }) },
  );
  expect(replay.status).toBe(304);
});

test("GET /api/project/[id]/notes — non-uuid and cross-team project 404", async () => {
  const f = await seedUserOrgProject("notes-404a");
  const g = await seedUserOrgProject("notes-404b");
  setSession({ user: { id: f.userId } });

  const bad = await listGET(get("/api/project/not-a-uuid/notes"), {
    params: Promise.resolve({ projectId: "not-a-uuid" }),
  });
  expect(bad.status).toBe(404);

  const foreign = await listGET(get(`/api/project/${g.projectId}/notes`), {
    params: Promise.resolve({ projectId: g.projectId }),
  });
  expect(foreign.status).toBe(404);
});

test("GET /api/note/[id] — full composition with body, mentions, links; ETag on updated_at; 304 replay", async () => {
  const f = await seedUserOrgProject("note-full");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "Main",
    body: "the full body",
  });
  const outTarget = await createNote(ctx, {
    projectId: f.projectId,
    title: "Out",
  });
  const inSource = await createNote(ctx, {
    projectId: f.projectId,
    title: "In",
  });
  const taskId = await addTask(f.projectId, "note-full");
  await linkNoteTask(note.id, taskId, "reference");
  await su(async (sql) => {
    await sql`
      INSERT INTO note_links ("source_note_id", "target_note_id")
      VALUES (${note.id}, ${outTarget.id}), (${inSource.id}, ${note.id})
    `;
  });
  setSession({ user: { id: f.userId } });

  const res = await noteGET(get(`/api/note/${note.id}`), {
    params: Promise.resolve({ noteId: note.id }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    note: { body: string; updatedAt: string };
    mentions: { kind: string; taskRef: string }[];
    linksOut: { id: string }[];
    linksIn: { id: string }[];
  };
  expect(body.note.body).toBe("the full body");
  expect(body.mentions).toEqual([
    expect.objectContaining({ kind: "reference", taskRef: "PRJnote-full-1" }),
  ]);
  expect(body.linksOut.map((l) => l.id)).toEqual([outTarget.id]);
  expect(body.linksIn.map((l) => l.id)).toEqual([inSource.id]);
  const etag = res.headers.get("etag");
  expect(etag).toBe(`"${new Date(body.note.updatedAt).getTime()}"`);

  const replay = await noteGET(
    get(`/api/note/${note.id}`, { "if-none-match": etag! }),
    { params: Promise.resolve({ noteId: note.id }) },
  );
  expect(replay.status).toBe(304);
  expect(await replay.text()).toBe("");
});

test("GET /api/note/[id] — cross-team note and non-uuid id 404", async () => {
  const f = await seedUserOrgProject("note-403a");
  const g = await seedUserOrgProject("note-403b");
  const foreignNote = await createNote(makeAuthContext(g.userId), {
    projectId: g.projectId,
    title: "Foreign",
  });
  setSession({ user: { id: f.userId } });

  const foreign = await noteGET(get(`/api/note/${foreignNote.id}`), {
    params: Promise.resolve({ noteId: foreignNote.id }),
  });
  expect(foreign.status).toBe(404);

  const bad = await noteGET(get("/api/note/not-a-uuid"), {
    params: Promise.resolve({ noteId: "not-a-uuid" }),
  });
  expect(bad.status).toBe(404);
});

test("GET /api/note/[id] — trashed note 404s even with a matching stale ETag", async () => {
  const f = await seedUserOrgProject("note-trash");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Doomed",
  });
  setSession({ user: { id: f.userId } });

  const res = await noteGET(get(`/api/note/${note.id}`), {
    params: Promise.resolve({ noteId: note.id }),
  });
  const etag = res.headers.get("etag");

  await trashNote(note.id);

  const stale = await noteGET(
    get(`/api/note/${note.id}`, { "if-none-match": etag! }),
    { params: Promise.resolve({ noteId: note.id }) },
  );
  expect(stale.status).toBe(404);
});

test("GET /api/project/[id]/notes/search — ranked snippet hits without body; over-length q 400", async () => {
  const f = await seedUserOrgProject("notes-search");
  const ctx = makeAuthContext(f.userId);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Airships",
    body: "a zeppelin floats over the city",
  });
  await createNote(ctx, { projectId: f.projectId, title: "Unrelated" });
  setSession({ user: { id: f.userId } });

  const res = await searchGET(
    get(`/api/project/${f.projectId}/notes/search?q=zeppelin`),
    { params: Promise.resolve({ projectId: f.projectId }) },
  );
  expect(res.status).toBe(200);
  const hits = (await res.json()) as Record<string, unknown>[];
  expect(hits.length).toBe(1);
  expect(hits[0].snippet).toContain("zeppelin");
  expect(typeof hits[0].rank).toBe("number");
  expect(hits[0]).not.toHaveProperty("body");

  const long = await searchGET(
    get(`/api/project/${f.projectId}/notes/search?q=${"x".repeat(257)}`),
    { params: Promise.resolve({ projectId: f.projectId }) },
  );
  expect(long.status).toBe(400);
});

test("GET /api/task/[id]/notes — slim backlinks with kind, dedupe priority, trashed excluded", async () => {
  const f = await seedUserOrgProject("task-notes");
  const ctx = makeAuthContext(f.userId);
  const taskId = await addTask(f.projectId, "backlinks");
  const linked = await createNote(ctx, {
    projectId: f.projectId,
    title: "Linked",
  });
  const dual = await createNote(ctx, { projectId: f.projectId, title: "Dual" });
  const trashed = await createNote(ctx, {
    projectId: f.projectId,
    title: "Trashed",
  });
  await linkNoteTask(linked.id, taskId, "reference");
  await linkNoteTask(dual.id, taskId, "mention");
  await linkNoteTask(dual.id, taskId, "spec_of");
  await linkNoteTask(trashed.id, taskId, "mention");
  await trashNote(trashed.id);
  setSession({ user: { id: f.userId } });

  const res = await backlinksGET(get(`/api/task/${taskId}/notes`), {
    params: Promise.resolve({ taskId }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toBeTruthy();
  const rows = (await res.json()) as { id: string; kind: string }[];
  expect(rows.length).toBe(2);
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(linked.id)?.kind).toBe("reference");
  expect(byId.get(dual.id)?.kind).toBe("spec_of");
  for (const row of rows) expect(row).not.toHaveProperty("body");
});

test("GET /api/task/[id]/notes — non-uuid and cross-team task 404; unauthenticated 401 sweep", async () => {
  const f = await seedUserOrgProject("task-notes-404");
  const g = await seedUserOrgProject("task-notes-404b");
  const foreignTask = await addTask(g.projectId, "foreign");
  setSession({ user: { id: f.userId } });

  const bad = await backlinksGET(get("/api/task/not-a-uuid/notes"), {
    params: Promise.resolve({ taskId: "not-a-uuid" }),
  });
  expect(bad.status).toBe(404);

  const foreign = await backlinksGET(get(`/api/task/${foreignTask}/notes`), {
    params: Promise.resolve({ taskId: foreignTask }),
  });
  expect(foreign.status).toBe(404);

  setSession(null);
  const uuid = f.projectId;
  const responses = await Promise.all([
    listGET(get(`/api/project/${uuid}/notes`), {
      params: Promise.resolve({ projectId: uuid }),
    }),
    noteGET(get(`/api/note/${uuid}`), {
      params: Promise.resolve({ noteId: uuid }),
    }),
    searchGET(get(`/api/project/${uuid}/notes/search?q=x`), {
      params: Promise.resolve({ projectId: uuid }),
    }),
    backlinksGET(get(`/api/task/${uuid}/notes`), {
      params: Promise.resolve({ taskId: uuid }),
    }),
  ]);
  for (const r of responses) expect(r.status).toBe(401);
});
