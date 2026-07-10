import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
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
 * Seed a team note with two body revisions (v1, v2).
 *
 * @param ctx - Authoring context.
 * @param projectId - Project the note belongs to.
 * @returns The live note summary after the second write.
 */
async function seedNoteWithRevisions(ctx: AuthContext, projectId: string) {
  const note = await createNote(ctx, {
    projectId,
    title: "Draft",
    body: "first body",
    visibility: "team",
  });
  return updateNote(ctx, note.id, { title: "Draft v2", body: "second body" });
}

describe("restoreNoteRevision — append-only revert through updateNote", () => {
  test("restore reverts title/body, appends a revision, and leaves prior revisions untouched", async () => {
    const fx = await seedUserOrgProject("rev-restore");
    const ctx = makeAuthContext(fx.userId);
    const note = await seedNoteWithRevisions(ctx, fx.projectId);

    const before = await listNoteRevisions(ctx, note.id);
    expect(before.revisions.map((r) => r.version)).toEqual([2, 1]);

    const restored = await restoreNoteRevision(ctx, note.id, 1);
    expect(restored.title).toBe("Draft");
    expect(restored.version).toBe(3);

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
    expect(event.metadata.version).toBe(3);
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
    expect(after.currentVersion).toBe(2);
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
    expect(restored.version).toBe(2);
    const after = await listNoteRevisions(ctx, note.id);
    expect(after.revisions.map((r) => r.version)).toEqual([2, 1]);
  });
});
