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
import { ForbiddenError } from "@/lib/auth/authorization";
import { ProjectArchivedError } from "@/lib/graph/errors";
import { NOTE_TITLE_MAX_BYTES } from "@/lib/db/schema";
import { superuserPool } from "@/tests/setup/global";

afterEach(async () => {
  await truncateAll();
});

/**
 * Insert a second user as a member of an existing organization.
 *
 * @param organizationId - Target organization id.
 * @param suffix - Suffix added to name/email so fixtures don't collide.
 * @returns The new user's id.
 */
async function seedTeammate(
  organizationId: string,
  suffix: string,
): Promise<string> {
  const sql = superuserPool();
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES (${"User " + suffix}, ${"user" + suffix + "@test.local"}, true, now())
    RETURNING id
  `;
  await sql`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${organizationId}, ${u.id}, 'member', now())
  `;
  return u.id;
}

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

test("updateNote drops unchanged fields and no-ops equal-value patches", async () => {
  const f = await seedUserOrgProject("notenoop");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "N",
    body: "same",
    tags: ["a"],
    visibility: "team",
  });

  const noop = await updateNote(ctx, note.id, {
    title: "N",
    body: "same",
    tags: ["a"],
  });
  expect(noop.updatedAt.getTime()).toBe(note.updatedAt.getTime());
  expect(noop.version).toBe(note.version);

  const mixed = await updateNote(ctx, note.id, {
    title: "Renamed",
    locked: false,
  });
  expect(mixed.updatedAt.getTime()).toBeGreaterThan(note.updatedAt.getTime());

  const sr = serviceRoleConnect();
  const rows = await sr<
    { type: string; metadata: { fields?: string[] } | null }[]
  >`
    SELECT type, metadata FROM activity_events
    WHERE project_id = ${f.projectId} ORDER BY created_at`;
  expect(rows.map((r) => r.type)).toEqual(["note_created", "note_updated"]);
  expect(rows[1].metadata?.fields).toEqual(["title"]);
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

test("moveFolder with a new leaf renames the subtree in place", async () => {
  const f = await seedUserOrgProject("noterename");
  const ctx = makeAuthContext(f.userId);
  const inB = await createNote(ctx, {
    projectId: f.projectId,
    title: "In a/b",
    folder: "a/b",
  });
  const deep = await createNote(ctx, {
    projectId: f.projectId,
    title: "In a/b/c",
    folder: "a/b/c",
  });

  const renamed = await moveFolder(ctx, f.projectId, "a/b", "a", "renamed");
  expect(renamed).toEqual({ dest: "a/renamed", movedCount: 2 });

  const tree = await getNoteTreeList(ctx, f.projectId);
  const folders = new Map(tree.map((n) => [n.id, n.folder]));
  expect(folders.get(inB.id)).toBe("a/renamed");
  expect(folders.get(deep.id)).toBe("a/renamed/c");

  const noOp = await moveFolder(ctx, f.projectId, "a/renamed", "a", "renamed");
  expect(noOp).toEqual({ dest: "a/renamed", movedCount: 0 });

  await expect(
    moveFolder(ctx, f.projectId, "a/renamed", "a", "  /  "),
  ).rejects.toBeInstanceOf(NoteValidationError);
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

test("note reads are 404-shaped for foreign and malformed ids", async () => {
  const mine = await seedUserOrgProject("noteacc1");
  const theirs = await seedUserOrgProject("noteacc2");
  const theirNote = await createNote(makeAuthContext(theirs.userId), {
    projectId: theirs.projectId,
    title: "Secret",
  });

  const ctx = makeAuthContext(mine.userId);
  let foreignErr: unknown;
  try {
    await getNoteFull(ctx, theirNote.id);
  } catch (e) {
    foreignErr = e;
  }
  expect(foreignErr).toBeInstanceOf(ForbiddenError);
  expect((foreignErr as ForbiddenError).resource).toBe("note");

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

test("restore keeps a numeric-title slug base intact", async () => {
  const f = await seedUserOrgProject("noterel");
  const ctx = makeAuthContext(f.userId);
  const original = await createNote(ctx, {
    projectId: f.projectId,
    title: "Release 2",
  });
  expect(original.slug).toBe("release-2");

  await deleteNote(ctx, original.id);
  const squatter = await createNote(ctx, {
    projectId: f.projectId,
    title: "Release 2",
  });
  expect(squatter.slug).toBe("release-2");

  const restored = await restoreNote(ctx, original.id);
  expect(restored.slug).toBe("release-2-2");
});

test("restore after a title rename still detects a live slug holder", async () => {
  const f = await seedUserOrgProject("noteren");
  const ctx = makeAuthContext(f.userId);
  const original = await createNote(ctx, {
    projectId: f.projectId,
    title: "Alpha",
  });
  await updateNote(ctx, original.id, { title: "Beta" });
  await deleteNote(ctx, original.id);
  const squatter = await createNote(ctx, {
    projectId: f.projectId,
    title: "Alpha",
  });
  expect(squatter.slug).toBe("alpha");

  const restored = await restoreNote(ctx, original.id);
  expect(restored.slug).toBe("beta");
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

test("slug allocation dedupes past a teammate's private note", async () => {
  const f = await seedUserOrgProject("noteprv");
  const mateId = await seedTeammate(f.organizationId, "noteprv2");

  const mine = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Roadmap",
  });
  expect(mine.slug).toBe("roadmap");

  const theirs = await createNote(makeAuthContext(mateId), {
    projectId: f.projectId,
    title: "Roadmap",
  });
  expect(theirs.slug).toBe("roadmap-2");
});

test("restore auto-suffixes past a teammate's private slug holder", async () => {
  const f = await seedUserOrgProject("noteprvr");
  const mateId = await seedTeammate(f.organizationId, "noteprvr2");
  const ctx = makeAuthContext(f.userId);

  const mine = await createNote(ctx, { projectId: f.projectId, title: "Plan" });
  await deleteNote(ctx, mine.id);
  const squatter = await createNote(makeAuthContext(mateId), {
    projectId: f.projectId,
    title: "Plan",
  });
  expect(squatter.slug).toBe("plan");

  const restored = await restoreNote(ctx, mine.id);
  expect(restored.slug).toBe("plan-2");
});

test("moveFolder no-op still gates project access and archived status", async () => {
  const mine = await seedUserOrgProject("notemvg1");
  const theirs = await seedUserOrgProject("notemvg2");
  const ctx = makeAuthContext(mine.userId);

  await expect(
    moveFolder(ctx, theirs.projectId, "docs/api", "docs"),
  ).rejects.toBeInstanceOf(ForbiddenError);

  const sql = superuserPool();
  await sql`UPDATE projects SET status = 'archived' WHERE id = ${mine.projectId}`;
  await expect(
    moveFolder(ctx, mine.projectId, "docs/api", "docs"),
  ).rejects.toBeInstanceOf(ProjectArchivedError);
});

test("metadata caps reject oversized summary, labels, and feed ids", async () => {
  const f = await seedUserOrgProject("notecaps");
  const ctx = makeAuthContext(f.userId);

  await expect(
    createNote(ctx, {
      projectId: f.projectId,
      title: "N",
      summary: "s".repeat(1001),
    }),
  ).rejects.toBeInstanceOf(NoteValidationError);
  await expect(
    createNote(ctx, {
      projectId: f.projectId,
      title: "N",
      tags: ["t".repeat(201)],
    }),
  ).rejects.toBeInstanceOf(NoteValidationError);
  await expect(
    createNote(ctx, {
      projectId: f.projectId,
      title: "N",
      category: "c".repeat(201),
    }),
  ).rejects.toBeInstanceOf(NoteValidationError);

  const note = await createNote(ctx, { projectId: f.projectId, title: "N" });
  await expect(
    updateNote(ctx, note.id, {
      tags: Array.from({ length: 501 }, (_, i) => `t${i}`),
    }),
  ).rejects.toBeInstanceOf(NoteValidationError);
  await expect(
    updateNote(ctx, note.id, { feedTaskIds: ["not-a-uuid"] }),
  ).rejects.toBeInstanceOf(NoteValidationError);
});

test("only team-visible note writes record activity events", async () => {
  const f = await seedUserOrgProject("noteact");
  const ctx = makeAuthContext(f.userId);
  const sr = serviceRoleConnect();

  const hidden = await createNote(ctx, { projectId: f.projectId, title: "P" });
  await updateNote(ctx, hidden.id, { body: "secret" });
  await moveNote(ctx, hidden.id, "drafts");
  await requestShare(ctx, hidden.id);
  await deleteNote(ctx, hidden.id);
  await restoreNote(ctx, hidden.id);
  const privateRows = await sr<{ type: string }[]>`
    SELECT type FROM activity_events WHERE project_id = ${f.projectId}`;
  expect(privateRows.length).toBe(0);

  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "N",
    visibility: "team",
  });
  await updateNote(ctx, note.id, { body: "hello" });
  const rows = await sr<{ type: string; task_id: string | null }[]>`
    SELECT type, task_id FROM activity_events
    WHERE project_id = ${f.projectId} ORDER BY created_at`;
  expect(rows.map((r) => r.type)).toEqual(["note_created", "note_updated"]);
  expect(rows.every((r) => r.task_id === null)).toBe(true);
});

test("flipping a note to team via updateNote clears the share request", async () => {
  const f = await seedUserOrgProject("noteflip");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, { projectId: f.projectId, title: "N" });
  await requestShare(ctx, note.id);

  await updateNote(ctx, note.id, { visibility: "team" });

  const sr = serviceRoleConnect();
  const [row] = await sr<
    { visibility: string; share_requested_by: string | null }[]
  >`SELECT visibility, share_requested_by FROM notes WHERE id = ${note.id}`;
  expect(row.visibility).toBe("team");
  expect(row.share_requested_by).toBeNull();
});

test("only the creator can flip a team note to private", async () => {
  const f = await seedUserOrgProject("noteflip2");
  const mateId = await seedTeammate(f.organizationId, "noteflip2b");
  const note = await createNote(makeAuthContext(f.userId), {
    projectId: f.projectId,
    title: "Shared",
    visibility: "team",
  });

  await expect(
    updateNote(makeAuthContext(mateId), note.id, { visibility: "private" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  const back = await updateNote(makeAuthContext(f.userId), note.id, {
    visibility: "private",
  });
  expect(back.id).toBe(note.id);
});

test("delete and restore no-op paths still reject archived projects", async () => {
  const f = await seedUserOrgProject("notearch");
  const ctx = makeAuthContext(f.userId);
  const trashed = await createNote(ctx, { projectId: f.projectId, title: "T" });
  await deleteNote(ctx, trashed.id);
  const live = await createNote(ctx, { projectId: f.projectId, title: "L" });

  const sql = superuserPool();
  await sql`UPDATE projects SET status = 'archived' WHERE id = ${f.projectId}`;

  await expect(deleteNote(ctx, trashed.id)).rejects.toBeInstanceOf(
    ProjectArchivedError,
  );
  await expect(restoreNote(ctx, live.id)).rejects.toBeInstanceOf(
    ProjectArchivedError,
  );
});

test("body writes flip embedding_status to stale only when in the pipeline", async () => {
  const f = await seedUserOrgProject("noteemb");
  const ctx = makeAuthContext(f.userId);
  const note = await createNote(ctx, {
    projectId: f.projectId,
    title: "N",
    body: "v1",
  });
  const sr = serviceRoleConnect();

  await updateNote(ctx, note.id, { body: "v2" });
  const [untouched] = await sr<{ embedding_status: string }[]>`
    SELECT embedding_status FROM notes WHERE id = ${note.id}`;
  expect(untouched.embedding_status).toBe("none");

  await sr`UPDATE notes SET embedding_status = 'pending' WHERE id = ${note.id}`;
  await updateNote(ctx, note.id, { body: "v3" });
  const [flipped] = await sr<{ embedding_status: string }[]>`
    SELECT embedding_status FROM notes WHERE id = ${note.id}`;
  expect(flipped.embedding_status).toBe("stale");
});
