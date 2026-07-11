import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { makeAuthContext, type AuthContext } from "@/lib/auth/context";
import {
  createNote,
  listNoteRevisions,
  NoteAgentReadOnlyError,
  NoteLockedError,
  NoteStaleWriteError,
  NoteValidationError,
  restoreNoteRevision,
  updateNote,
} from "@/lib/data/note";

afterEach(async () => {
  await truncateAll();
});

/**
 * Build an MCP-source auth context for the given user.
 *
 * @param userId - Verified user id.
 * @returns Auth context whose actor source is `mcp`.
 */
function mcpContext(userId: string): AuthContext {
  return makeAuthContext(userId, { source: "mcp", userId, clientId: null });
}

/**
 * Insert a new user and add them to an existing org as a plain member.
 *
 * @param organizationId - Org the new member joins.
 * @param suffix - Unique suffix for the user's name and email.
 * @returns The new user's id.
 */
async function seedSecondMember(
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

/**
 * Seed a team note whose stored checkpoints are v1 and v2 with the live
 * note at v3: the v1 creation snapshot, a web body write (same author
 * inside the quiet window, so no checkpoint), and an MCP body write that
 * archives the v2 pre-image unconditionally.
 *
 * @param ctx - Authoring context.
 * @param projectId - Project the note belongs to.
 * @returns The live note summary after the third write.
 */
async function seedNoteWithRevisions(ctx: AuthContext, projectId: string) {
  const note = await createNote(ctx, {
    projectId,
    title: "Draft",
    body: "first body",
    visibility: "team",
  });
  await updateNote(ctx, note.id, { title: "Draft v2", body: "second body" });
  return updateNote(mcpContext(ctx.userId), note.id, { body: "third body" });
}

describe("restoreNoteRevision: append-only revert through updateNote", () => {
  test("restore reverts title/body, appends a revision, and leaves prior revisions untouched", async () => {
    const fx = await seedUserOrgProject("rev-restore");
    const ctx = makeAuthContext(fx.userId);
    const note = await seedNoteWithRevisions(ctx, fx.projectId);

    const before = await listNoteRevisions(ctx, note.id);
    expect(before.revisions.map((r) => r.version)).toEqual([2, 1]);

    const restored = await restoreNoteRevision(ctx, note.id, 1);
    expect(restored.title).toBe("Draft");
    expect(restored.version).toBe(4);

    const sr = serviceRoleConnect();
    const [live] = await sr<{ title: string; body: string }[]>`
      SELECT title, body FROM notes WHERE id = ${note.id}
    `;
    expect(live.title).toBe("Draft");
    expect(live.body).toBe("first body");

    const after = await listNoteRevisions(ctx, note.id);
    expect(after.revisions.map((r) => r.version)).toEqual([3, 2, 1]);
    const v1 = await sr<{ title: string; body: string }[]>`
      SELECT title, body FROM note_revisions
      WHERE note_id = ${note.id} AND version = 1
    `;
    expect(v1[0]).toEqual({ title: "Draft", body: "first body" });
  });

  test("restore emits a note_updated event naming the source version", async () => {
    const fx = await seedUserOrgProject("rev-event");
    const ctx = makeAuthContext(fx.userId);
    const note = await seedNoteWithRevisions(ctx, fx.projectId);

    await restoreNoteRevision(ctx, note.id, 1);

    const sr = serviceRoleConnect();
    const [event] = await sr<
      { type: string; summary: string; metadata: Record<string, unknown> }[]
    >`
      SELECT type, summary, metadata FROM activity_events
      WHERE note_id = ${note.id}
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(event.type).toBe("note_updated");
    expect(event.summary).toBe('restored note "Draft" to v1');
    expect(event.metadata.restoredFromVersion).toBe(1);
    expect(event.metadata.version).toBe(4);
  });

  test("a stale ifUpdatedAt token rejects without a write", async () => {
    const fx = await seedUserOrgProject("rev-cas");
    const ctx = makeAuthContext(fx.userId);
    const note = await seedNoteWithRevisions(ctx, fx.projectId);

    await expect(
      restoreNoteRevision(ctx, note.id, 1, {
        ifUpdatedAt: new Date(0).toISOString(),
      }),
    ).rejects.toBeInstanceOf(NoteStaleWriteError);
    const after = await listNoteRevisions(ctx, note.id);
    expect(after.revisions.map((r) => r.version)).toEqual([2, 1]);
  });

  test("a missing version rejects naming the available versions, without a write", async () => {
    const fx = await seedUserOrgProject("rev-missing");
    const ctx = makeAuthContext(fx.userId);
    const note = await seedNoteWithRevisions(ctx, fx.projectId);

    await expect(restoreNoteRevision(ctx, note.id, 9)).rejects.toThrow(
      /available versions: 2, 1/,
    );
    await expect(restoreNoteRevision(ctx, note.id, 0)).rejects.toBeInstanceOf(
      NoteValidationError,
    );
    const after = await listNoteRevisions(ctx, note.id);
    expect(after.currentVersion).toBe(3);
  });

  test("locked and agent-read-only rejections are inherited from updateNote", async () => {
    const fx = await seedUserOrgProject("rev-guard");
    const ctx = makeAuthContext(fx.userId);
    const note = await seedNoteWithRevisions(ctx, fx.projectId);

    await updateNote(ctx, note.id, { agentWritable: false });
    await expect(
      restoreNoteRevision(mcpContext(fx.userId), note.id, 1),
    ).rejects.toBeInstanceOf(NoteAgentReadOnlyError);

    await updateNote(ctx, note.id, { locked: true });
    await expect(restoreNoteRevision(ctx, note.id, 1)).rejects.toBeInstanceOf(
      NoteLockedError,
    );
  });

  test("restoring content identical to the live note is a no-op", async () => {
    const fx = await seedUserOrgProject("rev-noop");
    const ctx = makeAuthContext(fx.userId);
    const note = await seedNoteWithRevisions(ctx, fx.projectId);

    const restored = await restoreNoteRevision(ctx, note.id, 2);
    expect(restored.version).toBe(4);
    const again = await restoreNoteRevision(ctx, note.id, 2);
    expect(again.version).toBe(4);
    const after = await listNoteRevisions(ctx, note.id);
    expect(after.revisions.map((r) => r.version)).toEqual([3, 2, 1]);
  });

  test("another author's overwrite checkpoints the previous author's state unattributed", async () => {
    const fx = await seedUserOrgProject("rev-actor");
    const userB = await seedSecondMember(fx.organizationId, "rev-actor-b");
    const ctxA = makeAuthContext(fx.userId);
    const note = await createNote(ctxA, {
      projectId: fx.projectId,
      title: "Shared",
      body: "alice v1",
      visibility: "team",
    });
    await updateNote(ctxA, note.id, { body: "alice v2" });
    await updateNote(makeAuthContext(userB), note.id, { body: "bob v3" });

    const list = await listNoteRevisions(ctxA, note.id);
    expect(list.revisions.map((r) => r.version)).toEqual([2, 1]);

    const sr = serviceRoleConnect();
    const [archived] = await sr<{ body: string; created_by: string | null }[]>`
      SELECT body, created_by FROM note_revisions
      WHERE note_id = ${note.id} AND version = 2
    `;
    expect(archived.body).toBe("alice v2");
    expect(archived.created_by).toBeNull();
  });

  test("pre-share revisions are creator-only: hidden from a member's list and restore", async () => {
    const fx = await seedUserOrgProject("rev-fence");
    const userB = await seedSecondMember(fx.organizationId, "rev-fence-b");
    const ctxA = makeAuthContext(fx.userId);
    const mcpA = mcpContext(fx.userId);
    const note = await createNote(ctxA, {
      projectId: fx.projectId,
      title: "Draft",
      body: "private v1",
      visibility: "private",
    });
    await updateNote(mcpA, note.id, { body: "private v2" });
    await updateNote(mcpA, note.id, { body: "private v3" });
    await updateNote(ctxA, note.id, { visibility: "team" });
    await updateNote(mcpA, note.id, { body: "shared v4" });
    await updateNote(mcpA, note.id, { body: "shared v5" });

    const ctxB = makeAuthContext(userB);
    const listB = await listNoteRevisions(ctxB, note.id);
    expect(listB.currentVersion).toBe(5);
    const visibleToB = listB.revisions.map((r) => r.version);
    expect(visibleToB).toContain(4);
    expect(visibleToB).not.toContain(1);
    expect(visibleToB).not.toContain(2);

    await expect(restoreNoteRevision(ctxB, note.id, 1)).rejects.toBeInstanceOf(
      NoteValidationError,
    );
    await expect(restoreNoteRevision(ctxB, note.id, 2)).rejects.toBeInstanceOf(
      NoteValidationError,
    );

    const listA = await listNoteRevisions(ctxA, note.id);
    expect(listA.revisions.map((r) => r.version)).toEqual([4, 3, 2, 1]);
    const restored = await restoreNoteRevision(ctxA, note.id, 1);
    expect(restored.version).toBe(6);
  });
});
