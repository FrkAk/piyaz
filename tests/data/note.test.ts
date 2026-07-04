import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import {
  approveShareRequest,
  createNote,
  deleteNote,
  deleteNotePreview,
  getNoteFull,
  getNotesTreeVersion,
  getNoteTreeList,
  moveFolder,
  moveNote,
  requestShare,
  restoreNote,
  updateNote,
  FolderCycleError,
  NoteShareStateError,
  NoteStaleWriteError,
  NoteValidationError,
} from "@/lib/data/note";
import { makeAuthContext } from "@/lib/auth/context";
import { assertNoteAccess, ForbiddenError } from "@/lib/auth/authorization";
import { NOTE_TITLE_MAX_BYTES } from "@/lib/db/schema";

afterEach(async () => {
  await truncateAll();
});

test("concurrent createNote calls dedupe slugs under the project lock", async () => {
  const f = await seedUserOrgProject("noteslug");
  const ctx = makeAuthContext(f.userId);

  const [a, b] = await Promise.all([
    createNote(ctx, { projectId: f.projectId, title: "Auth" }),
    createNote(ctx, { projectId: f.projectId, title: "Auth" }),
  ]);
  expect(new Set([a.slug, b.slug])).toEqual(new Set(["auth", "auth-2"]));

  const c = await createNote(ctx, { projectId: f.projectId, title: "Auth" });
  expect(c.slug).toBe("auth-3");
});

test("slugifyTitle shapes titles into stable kebab slugs", async () => {
  const f = await seedUserOrgProject("noteshape");
  const ctx = makeAuthContext(f.userId);

  const punct = await createNote(ctx, {
    projectId: f.projectId,
    title: "Hello, World!",
  });
  expect(punct.slug).toBe("hello-world");

  const empty = await createNote(ctx, { projectId: f.projectId, title: "!!!" });
  expect(empty.slug).toBe("untitled");

  const unicode = await createNote(ctx, {
    projectId: f.projectId,
    title: "Çok Önemli Not",
  });
  expect(unicode.slug).toBe("cok-onemli-not");

  await expect(
    createNote(ctx, {
      projectId: f.projectId,
      title: "x".repeat(NOTE_TITLE_MAX_BYTES + 1),
    }),
  ).rejects.toBeInstanceOf(NoteValidationError);
});

test("createNote defaults access to open despite the DB column default", async () => {
  const f = await seedUserOrgProject("noteopen");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, { projectId: f.projectId, title: "N" });

  const full = await getNoteFull(ctx, note.id);
  expect(full.note.agentWritable).toBe(true);
  expect(full.note.locked).toBe(false);
  expect(full.note.visibility).toBe("private");
  expect(full.note.type).toBe("reference");
  expect(full.note.feedMode).toBe("none");
  expect(full.note.embeddingStatus).toBe("none");
});

test("updateNote enforces the ifUpdatedAt compare-and-swap", async () => {
  const f = await seedUserOrgProject("notecas");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "N",
    body: "v1",
  });

  const bumped = await updateNote(ctx, note.id, { body: "v2" });
  expect(bumped.version).toBe(2);

  let staleErr: unknown;
  try {
    await updateNote(
      ctx,
      note.id,
      { body: "v3" },
      note.updatedAt.toISOString(),
    );
  } catch (e) {
    staleErr = e;
  }
  expect(staleErr).toBeInstanceOf(NoteStaleWriteError);
  const err = staleErr as NoteStaleWriteError;
  expect(err.currentVersion).toBe(2);
  expect(err.currentUpdatedAt.getTime()).toBe(bumped.updatedAt.getTime());

  const fresh = await updateNote(
    ctx,
    note.id,
    { body: "v3" },
    bumped.updatedAt.toISOString(),
  );
  expect(fresh.version).toBe(3);
});

test("body writes snapshot revisions and prune past the retention cap", async () => {
  const f = await seedUserOrgProject("noterev");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "N",
    body: "v1",
  });
  for (let i = 2; i <= 55; i++) {
    await updateNote(ctx, note.id, { body: `v${i}` });
  }

  const sr = serviceRoleConnect();
  const rows = await sr<{ version: number }[]>`
    SELECT version FROM note_revisions WHERE note_id = ${note.id}
    ORDER BY version`;
  expect(rows.length).toBe(50);
  expect(rows[0].version).toBe(6);
  expect(rows.at(-1)?.version).toBe(55);
});

test("moveFolder re-parents the subtree in one update with a cycle guard", async () => {
  const f = await seedUserOrgProject("notemove");
  const ctx = makeAuthContext(f.userId);
  const inA = await createNote(ctx, {
    projectId: f.projectId,
    title: "In a/b",
    folder: "a/b",
  });
  const deep = await createNote(ctx, {
    projectId: f.projectId,
    title: "In a/b/c",
    folder: "a/b/c",
  });
  const sibling = await createNote(ctx, {
    projectId: f.projectId,
    title: "In ab",
    folder: "ab",
  });

  const moved = await moveFolder(ctx, f.projectId, "a/b", "x");
  expect(moved).toEqual({ dest: "x/b", movedCount: 2 });

  const tree = await getNoteTreeList(ctx, f.projectId);
  const folders = new Map(tree.map((n) => [n.id, n.folder]));
  expect(folders.get(inA.id)).toBe("x/b");
  expect(folders.get(deep.id)).toBe("x/b/c");
  expect(folders.get(sibling.id)).toBe("ab");

  await expect(moveFolder(ctx, f.projectId, "x", "x/b")).rejects.toBeInstanceOf(
    FolderCycleError,
  );
  await expect(moveFolder(ctx, f.projectId, "x", "x")).rejects.toBeInstanceOf(
    FolderCycleError,
  );
});

test("moveFolder rewrites paths containing non-BMP characters correctly", async () => {
  const f = await seedUserOrgProject("notemoji");
  const ctx = makeAuthContext(f.userId);
  const parent = await createNote(ctx, {
    projectId: f.projectId,
    title: "In emoji folder",
    folder: "📁a",
  });
  const child = await createNote(ctx, {
    projectId: f.projectId,
    title: "Emoji child",
    folder: "📁a/child",
  });

  const moved = await moveFolder(ctx, f.projectId, "📁a", "x");
  expect(moved).toEqual({ dest: "x/📁a", movedCount: 2 });

  const tree = await getNoteTreeList(ctx, f.projectId);
  const folders = new Map(tree.map((n) => [n.id, n.folder]));
  expect(folders.get(parent.id)).toBe("x/📁a");
  expect(folders.get(child.id)).toBe("x/📁a/child");
});

test("moveFolder rejects moves that push a path past the folder cap", async () => {
  const f = await seedUserOrgProject("notecap");
  const ctx = makeAuthContext(f.userId);
  const longFolder = "f".repeat(500);
  await createNote(ctx, {
    projectId: f.projectId,
    title: "Deep",
    folder: longFolder,
  });

  await expect(
    moveFolder(ctx, f.projectId, longFolder, "p".repeat(20)),
  ).rejects.toBeInstanceOf(NoteValidationError);
});

test("moveNote relocates a single note", async () => {
  const f = await seedUserOrgProject("notemv1");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "N",
    folder: "Drafts",
  });
  const moved = await moveNote(ctx, note.id, "Architecture/Auth");
  expect(moved.folder).toBe("Architecture/Auth");
});

test("assertNoteAccess is 404-shaped for foreign and malformed ids", async () => {
  const mine = await seedUserOrgProject("noteacc1");
  const theirs = await seedUserOrgProject("noteacc2");
  const theirNote = await createNote(makeAuthContext(theirs.userId), {
    projectId: theirs.projectId,
    title: "Secret",
  });

  const ctx = makeAuthContext(mine.userId);
  let foreignErr: unknown;
  try {
    await assertNoteAccess(theirNote.id, ctx);
  } catch (e) {
    foreignErr = e;
  }
  expect(foreignErr).toBeInstanceOf(ForbiddenError);
  expect((foreignErr as ForbiddenError).resource).toBe("note");

  const malformed = assertNoteAccess("not-a-uuid", ctx);
  await expect(malformed).rejects.toBeInstanceOf(ForbiddenError);
  await expect(getNoteFull(ctx, "not-a-uuid")).rejects.toBeInstanceOf(
    ForbiddenError,
  );
});

test("soft delete hides the note and restore resolves slug collisions", async () => {
  const f = await seedUserOrgProject("notetrash");
  const ctx = makeAuthContext(f.userId);
  const original = await createNote(ctx, {
    projectId: f.projectId,
    title: "Auth",
  });

  const before = await getNotesTreeVersion(ctx, f.projectId);
  expect(before.liveCount).toBe(1);

  await deleteNote(ctx, original.id);
  expect((await getNoteTreeList(ctx, f.projectId)).length).toBe(0);
  await expect(getNoteFull(ctx, original.id)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  expect((await getNotesTreeVersion(ctx, f.projectId)).liveCount).toBe(0);

  const squatter = await createNote(ctx, {
    projectId: f.projectId,
    title: "Auth",
  });
  expect(squatter.slug).toBe("auth");

  const restored = await restoreNote(ctx, original.id);
  expect(restored.slug).toBe("auth-2");

  await deleteNote(ctx, restored.id);
  const kept = await restoreNote(ctx, restored.id);
  expect(kept.slug).toBe("auth-2");
});

test("deleteNote is idempotent and preview counts linked rows", async () => {
  const f = await seedUserOrgProject("notedel");
  const ctx = makeAuthContext(f.userId);
  const target = await createNote(ctx, {
    projectId: f.projectId,
    title: "Target",
  });
  const source = await createNote(ctx, {
    projectId: f.projectId,
    title: "Source",
    body: "links [[Target]]",
  });

  const preview = await deleteNotePreview(ctx, target.id);
  expect(preview.incomingLinks).toBe(1);
  expect(preview.outgoingLinks).toBe(0);

  const first = await deleteNote(ctx, source.id);
  const second = await deleteNote(ctx, source.id);
  expect(second.deletedAt.getTime()).toBe(first.deletedAt.getTime());
});

test("share request lifecycle: request, approve, reject invalid states", async () => {
  const f = await seedUserOrgProject("noteshare");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, { projectId: f.projectId, title: "N" });

  await expect(approveShareRequest(ctx, note.id)).rejects.toBeInstanceOf(
    NoteShareStateError,
  );

  await requestShare(ctx, note.id);
  const sr = serviceRoleConnect();
  const [pending] = await sr<
    { share_requested_by: string | null; visibility: string }[]
  >`SELECT share_requested_by, visibility FROM notes WHERE id = ${note.id}`;
  expect(pending.share_requested_by).toBe(f.userId);
  expect(pending.visibility).toBe("private");

  await approveShareRequest(ctx, note.id);
  const [approved] = await sr<
    { share_requested_by: string | null; visibility: string }[]
  >`SELECT share_requested_by, visibility FROM notes WHERE id = ${note.id}`;
  expect(approved.visibility).toBe("team");
  expect(approved.share_requested_by).toBeNull();

  await expect(requestShare(ctx, note.id)).rejects.toBeInstanceOf(
    NoteShareStateError,
  );
});

test("note writes record project-scoped activity events", async () => {
  const f = await seedUserOrgProject("noteact");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, { projectId: f.projectId, title: "N" });
  await updateNote(ctx, note.id, { body: "hello" });

  const sr = serviceRoleConnect();
  const rows = await sr<{ type: string; task_id: string | null }[]>`
    SELECT type, task_id FROM activity_events
    WHERE project_id = ${f.projectId} ORDER BY created_at`;
  expect(rows.map((r) => r.type)).toEqual(["note_created", "note_updated"]);
  expect(rows.every((r) => r.task_id === null)).toBe(true);
});
