import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import {
  createNote,
  createNoteFolder,
  getNoteFull,
  updateNote,
} from "@/lib/data/note";
import { handleNote, type NoteParams } from "@/lib/graph/tools/note";
import type { AuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

/**
 * Unwrap a successful ToolResult's data.
 *
 * @param result - Handler result expected to be ok.
 * @returns The data payload.
 */
function okData<T>(result: { ok: boolean }): T {
  expect(result.ok).toBe(true);
  return (result as { ok: true; data: T }).data;
}

/**
 * Unwrap a failed ToolResult's error message.
 *
 * @param result - Handler result expected to be a failure.
 * @returns The error string.
 */
function errText(result: { ok: boolean }): string {
  expect(result.ok).toBe(false);
  return (result as { ok: false; error: string }).error;
}

/** Slim row shape emitted by create for created and deduped notes. */
type CreatedNote = { ref: string; title: string; folder: string; slug: string };

/** Object payload shape returned by the create action. */
type CreatePayload = {
  created: CreatedNote[];
  deduped: CreatedNote[];
  _hints?: string[];
};

/** Object payload shape returned by the edit action. */
type EditPayload = {
  ref: string;
  applied: string[];
  version: number;
  updatedAt: string;
  _hints?: string[];
};

/**
 * Create one note through the tool and return its payload row.
 *
 * @param ctx - Resolved auth context.
 * @param project - Project identifier or UUID.
 * @param item - Create-item fields.
 * @returns The created row (ref, slug, folder, title).
 */
async function createOne(
  ctx: AuthContext,
  project: string,
  item: Record<string, unknown>,
): Promise<CreatedNote> {
  const payload = okData<CreatePayload>(
    await handleNote(
      { action: "create", project, notes: [item] } as NoteParams,
      ctx,
    ),
  );
  expect(payload.created).toHaveLength(1);
  return payload.created[0];
}

test("create applies the agent defaults and returns refs", async () => {
  const fx = await seedUserOrgProject("NC1");
  const ctx = makeAuthContext(fx.userId);

  const payload = okData<CreatePayload>(
    await handleNote(
      {
        action: "create",
        project: "PRJNC1",
        notes: [
          { title: "Deploy runbook", folder: "ops", body: "## Steps\nrun it" },
        ],
      },
      ctx,
    ),
  );
  expect(payload.created[0].ref).toBe("PRJNC1-N1");
  expect(payload.created[0].folder).toBe("ops");
  expect(payload._hints?.join(" ")).toContain("feedMode");

  const noteId = (await getNoteFull(ctx, await resolveId(ctx, fx, "PRJNC1-N1")))
    .note;
  expect(noteId.visibility).toBe("team");
  expect(noteId.feedMode).toBe("none");
  expect(noteId.agentWritable).toBe(true);
  expect(noteId.locked).toBe(false);
});

/**
 * Resolve a noteRef to its UUID via the read action's meta output.
 *
 * @param ctx - Resolved auth context.
 * @param fx - Seed fixture (unused; keeps call sites uniform).
 * @param ref - noteRef to resolve.
 * @returns The note UUID.
 */
async function resolveId(
  ctx: AuthContext,
  fx: { projectId: string },
  ref: string,
): Promise<string> {
  const { resolveNoteRef } = await import("@/lib/data/resolve-ref");
  return (await resolveNoteRef(ctx, ref)).noteId;
}

test("create is idempotent by (folder, title) and dedupes intra-batch", async () => {
  const fx = await seedUserOrgProject("NC2");
  const ctx = makeAuthContext(fx.userId);

  const first = okData<CreatePayload>(
    await handleNote(
      {
        action: "create",
        project: "PRJNC2",
        notes: [
          { title: "Conventions", folder: "docs" },
          { title: "Conventions", folder: "docs" },
          { title: "Conventions", folder: "other" },
        ],
      },
      ctx,
    ),
  );
  expect(first.created).toHaveLength(2);
  expect(first.deduped).toHaveLength(1);
  expect(first.deduped[0].ref).toBe(first.created[0].ref);

  const rerun = okData<CreatePayload>(
    await handleNote(
      {
        action: "create",
        project: "PRJNC2",
        notes: [{ title: "Conventions", folder: "docs" }],
      },
      ctx,
    ),
  );
  expect(rerun.created).toHaveLength(0);
  expect(rerun.deduped.map((d) => d.ref)).toEqual([first.created[0].ref]);

  const rejected = errText(
    await handleNote(
      {
        action: "create",
        project: "PRJNC2",
        notes: [{ title: "Conventions", folder: "docs" }],
        onDuplicate: "error",
      },
      ctx,
    ),
  );
  expect(rejected).toContain("already exist");
  expect(rejected).toContain("onDuplicate='skip'");
});

test("note refs resolve by ref, slug with project, and UUID; misses correct", async () => {
  const fx = await seedUserOrgProject("NC3");
  const ctx = makeAuthContext(fx.userId);
  const created = await createOne(ctx, "PRJNC3", { title: "Auth Spec" });

  const byRef = okData<Record<string, unknown>>(
    await handleNote(
      { action: "read", note: created.ref, fields: ["title"] },
      ctx,
    ),
  );
  expect(String(byRef)).toContain("Auth Spec");

  const bySlug = okData<Record<string, unknown>>(
    await handleNote(
      {
        action: "read",
        note: created.slug,
        project: "PRJNC3",
        fields: ["title"],
      },
      ctx,
    ),
  );
  expect(String(bySlug)).toContain("Auth Spec");

  const slugNoProject = errText(
    await handleNote({ action: "read", note: created.slug }, ctx),
  );
  expect(slugNoProject).toContain("slug together with project");

  const nearMiss = errText(
    await handleNote({ action: "read", note: "PRJNC3-N99" }, ctx),
  );
  expect(nearMiss).toContain("PRJNC3-N1");
  expect(nearMiss).toContain("piyaz_note");
});

test("edit folds body ops with task-editor semantics and CAS", async () => {
  const fx = await seedUserOrgProject("NC4");
  const ctx = makeAuthContext(fx.userId);
  const created = await createOne(ctx, "PRJNC4", {
    title: "Gotchas",
    body: "alpha beta alpha",
  });

  const multi = errText(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        operations: [
          { op: "str_replace", field: "body", oldStr: "alpha", newStr: "x" },
        ],
      },
      ctx,
    ),
  );
  expect(multi).toContain("matched 2 places in body");

  const edited = okData<EditPayload>(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        operations: [
          { op: "str_replace", field: "body", oldStr: "beta", newStr: "gamma" },
          { op: "append", field: "body", text: "appended line" },
          { op: "set", field: "summary", text: "one-liner" },
        ],
      },
      ctx,
    ),
  );
  expect(edited.applied).toEqual([
    "str_replace body",
    "append body",
    "set summary",
  ]);
  expect(edited.version).toBe(2);

  const stale = errText(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        ifUpdatedAt: "2020-01-01T00:00:00.000Z",
        operations: [{ op: "append", field: "body", text: "late write" }],
      },
      ctx,
    ),
  );
  expect(stale).toContain("Note changed since you last read it");
  expect(stale).toContain(edited.updatedAt);
  expect(stale).toContain("version 2");

  const governance = errText(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        operations: [
          {
            op: "set",
            field: "visibility" as never,
            value: "private",
          },
        ],
      },
      ctx,
    ),
  );
  expect(governance).toContain("request_share");
});

test("read serves meta with sections, one heading, and no stray body", async () => {
  const fx = await seedUserOrgProject("NC5");
  const ctx = makeAuthContext(fx.userId);
  const body = [
    "intro text",
    "## Setup",
    "setup content SECRET_SETUP",
    "## Usage",
    "usage content ONLY_USAGE",
  ].join("\n");
  const created = await createOne(ctx, "PRJNC5", { title: "Guide", body });

  const meta = okData<string>(
    await handleNote({ action: "read", note: created.ref }, ctx),
  );
  expect(meta).toContain("Sections");
  expect(meta).toContain("Setup | Usage");
  expect(meta).not.toContain("SECRET_SETUP");

  const section = okData<string>(
    await handleNote(
      { action: "read", note: created.ref, heading: "usage" },
      ctx,
    ),
  );
  expect(section).toContain("ONLY_USAGE");
  expect(section).not.toContain("SECRET_SETUP");

  const miss = errText(
    await handleNote(
      { action: "read", note: created.ref, heading: "Nope" },
      ctx,
    ),
  );
  expect(miss).toContain("Available: Setup | Usage");
});

test("an overwritten body recovers through a revision snapshot", async () => {
  const fx = await seedUserOrgProject("NC6");
  const ctx = agentCtx(fx.userId);
  const created = await createOne(ctx, "PRJNC6", {
    title: "Precious",
    body: "the original body",
  });

  await handleNote(
    {
      action: "edit",
      note: created.ref,
      operations: [{ op: "set", field: "body", text: "clobbered" }],
    },
    ctx,
  );

  const list = okData<string>(
    await handleNote(
      { action: "read", note: created.ref, fields: ["revisions"] },
      ctx,
    ),
  );
  expect(list).toContain("v1");
  expect(list).not.toContain("v2");

  const snapshot = okData<string>(
    await handleNote({ action: "read", note: created.ref, revision: 1 }, ctx),
  );
  expect(snapshot).toContain("the original body");

  const missing = errText(
    await handleNote({ action: "read", note: created.ref, revision: 9 }, ctx),
  );
  expect(missing).toContain("Available versions: 1");

  await handleNote(
    {
      action: "edit",
      note: created.ref,
      operations: [{ op: "set", field: "body", text: "the original body" }],
    },
    ctx,
  );
  const noteId = await resolveId(ctx, fx, created.ref);
  expect((await getNoteFull(ctx, noteId)).note.body).toBe("the original body");

  const afterRecovery = okData<string>(
    await handleNote(
      { action: "read", note: created.ref, fields: ["revisions"] },
      ctx,
    ),
  );
  expect(afterRecovery).toContain("v2");
  const clobberedSnapshot = okData<string>(
    await handleNote({ action: "read", note: created.ref, revision: 2 }, ctx),
  );
  expect(clobberedSnapshot).toContain("clobbered");
});

test("list renders the folder tree; move handles notes and folder subtrees", async () => {
  const fx = await seedUserOrgProject("NC7");
  const ctx = makeAuthContext(fx.userId);
  await handleNote(
    {
      action: "create",
      project: "PRJNC7",
      notes: [
        { title: "Root note" },
        { title: "Deep note", folder: "docs/adr" },
        { title: "Doc note", folder: "docs" },
      ],
    },
    ctx,
  );

  const tree = okData<string>(
    await handleNote({ action: "list", project: "PRJNC7" }, ctx),
  );
  expect(tree).toContain("(root)/");
  expect(tree).toContain("docs/");
  expect(tree).toContain("docs/adr/");
  expect(tree).toContain('"Root note"');

  const moved = okData<{ ref: string; folder: string }>(
    await handleNote(
      { action: "move", note: "PRJNC7-N1", folder: "docs" },
      ctx,
    ),
  );
  expect(moved.folder).toBe("docs");

  const renamed = okData<{ dest: string; movedCount: number }>(
    await handleNote(
      {
        action: "move",
        project: "PRJNC7",
        folder: "docs",
        destParent: "",
        newLeaf: "guides",
      },
      ctx,
    ),
  );
  expect(renamed.dest).toBe("guides");
  expect(renamed.movedCount).toBe(3);

  const cycle = errText(
    await handleNote(
      {
        action: "move",
        project: "PRJNC7",
        folder: "guides",
        destParent: "guides/adr",
      },
      ctx,
    ),
  );
  expect(cycle).toContain("into itself or a descendant");
});

test("delete previews, executes, and restore recovers by UUID", async () => {
  const fx = await seedUserOrgProject("NC8");
  const ctx = makeAuthContext(fx.userId);
  const created = await createOne(ctx, "PRJNC8", {
    title: "Ephemeral",
    body: "content",
  });

  const preview = okData<{ preview: { revisions: number }; _hints: string[] }>(
    await handleNote({ action: "delete", note: created.ref }, ctx),
  );
  expect(preview.preview.revisions).toBe(1);
  expect(preview._hints.join(" ")).toContain("preview=false");

  const deleted = okData<{ id: string; ref: string; _hints: string[] }>(
    await handleNote(
      { action: "delete", note: created.ref, preview: false },
      ctx,
    ),
  );
  expect(deleted.ref).toBe(created.ref);
  expect(deleted._hints.join(" ")).toContain("restore");

  const gone = errText(
    await handleNote({ action: "read", note: created.ref }, ctx),
  );
  expect(gone).toContain("not found");

  const restored = okData<{ ref: string; slug: string }>(
    await handleNote({ action: "restore", note: deleted.id }, ctx),
  );
  expect(restored.ref).toBe(created.ref);
});

test("link and unlink manage deliberate kinds; mentions stay derivation-owned", async () => {
  const fx = await seedUserOrgProject("NC9");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "Implement parser",
    description: "Parses the format. Two sentences to satisfy hints.",
  });
  const created = await createOne(ctx, "PRJNC9", {
    title: "Parser Spec",
    body: `See [[PRJNC9-${task.sequenceNumber}]] for the task.`,
  });

  const linked = okData<{ created: boolean }>(
    await handleNote(
      { action: "link", note: created.ref, task: task.id, kind: "spec_of" },
      ctx,
    ),
  );
  expect(linked.created).toBe(true);

  const duplicate = okData<{ created: boolean; _hints?: string[] }>(
    await handleNote(
      { action: "link", note: created.ref, task: task.id, kind: "spec_of" },
      ctx,
    ),
  );
  expect(duplicate.created).toBe(false);
  expect(duplicate._hints?.join(" ")).toContain("Treat as success");

  const noteId = await resolveId(ctx, fx, created.ref);
  const before = await getNoteFull(ctx, noteId);
  expect(before.mentions.map((m) => m.kind).sort()).toEqual([
    "mention",
    "spec_of",
  ]);

  const unlinked = okData<{ removed: boolean }>(
    await handleNote(
      { action: "unlink", note: created.ref, task: task.id, kind: "spec_of" },
      ctx,
    ),
  );
  expect(unlinked.removed).toBe(true);

  const after = await getNoteFull(ctx, noteId);
  expect(after.mentions.map((m) => m.kind)).toEqual(["mention"]);
});

test("search finds team notes regardless of feed mode plus own private notes", async () => {
  const fx = await seedUserOrgProject("NC10");
  const ctx = makeAuthContext(fx.userId);
  await createOne(ctx, "PRJNC10", {
    title: "Webhook retry policy",
    body: "retries use exponential backoff",
  });
  await createNote(ctx, {
    projectId: fx.projectId,
    title: "Private scratch",
    body: "backoff notes of my own",
    visibility: "private",
  });

  const hits = okData<{ text: string; _hints: string[] }>(
    await handleNote(
      { action: "search", project: "PRJNC10", query: "backoff" },
      ctx,
    ),
  );
  expect(hits.text).toContain("Webhook retry policy");
  expect(hits.text).toContain("Private scratch");
  expect(hits._hints.join(" ")).toContain("heading");

  const none = okData<string>(
    await handleNote(
      { action: "search", project: "PRJNC10", query: "zzzznothing" },
      ctx,
    ),
  );
  expect(none).toContain("No notes match");
});

test("a locked note rejects agent edits with corrective copy", async () => {
  const fx = await seedUserOrgProject("NC11");
  const ctx = makeAuthContext(fx.userId);
  const created = await createOne(ctx, "PRJNC11", { title: "Frozen" });
  const noteId = await resolveId(ctx, fx, created.ref);
  await updateNote(ctx, noteId, { locked: true });

  const rejected = errText(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        operations: [{ op: "append", field: "body", text: "nope" }],
      },
      ctx,
    ),
  );
  expect(rejected).toContain("locked");
  expect(rejected).toContain("unlock");
});

test("request_share applies to private notes and self-corrects on team notes", async () => {
  const fx = await seedUserOrgProject("NC12");
  const ctx = makeAuthContext(fx.userId);
  const privateNote = await createNote(ctx, {
    projectId: fx.projectId,
    title: "Draft findings",
    visibility: "private",
  });

  const requested = okData<{ ref: string; _hints: string[] }>(
    await handleNote({ action: "request_share", note: privateNote.id }, ctx),
  );
  expect(requested._hints.join(" ")).toContain("human approves");

  const teamNote = await createOne(ctx, "PRJNC12", { title: "Already shared" });
  const alreadyTeam = errText(
    await handleNote({ action: "request_share", note: teamNote.ref }, ctx),
  );
  expect(alreadyTeam).toContain("already visible to the team");
});

test("feedTaskIds accept task refs on create and edit", async () => {
  const fx = await seedUserOrgProject("NC13");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "Ship exporter",
    description: "Exports data. Second sentence for the hint gods.",
  });
  const taskRef = `PRJNC13-${task.sequenceNumber}`;

  const created = await createOne(ctx, "PRJNC13", {
    title: "Exporter constraints",
    type: "guidance",
    feedMode: "tasks",
    feedTaskIds: [taskRef],
  });
  const noteId = await resolveId(ctx, fx, created.ref);
  expect((await getNoteFull(ctx, noteId)).note.feedTaskIds).toEqual([task.id]);

  const fieldRead = okData<string>(
    await handleNote(
      { action: "read", note: created.ref, fields: ["feedTaskIds"] },
      ctx,
    ),
  );
  expect(fieldRead).toContain(taskRef);
  expect(fieldRead).not.toContain(task.id);

  const badRef = errText(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        operations: [
          { op: "set", field: "feedTaskIds", value: ["PRJNC13-999"] },
        ],
      },
      ctx,
    ),
  );
  expect(badRef).toContain("unresolved task ref");
  expect(badRef).toContain("PRJNC13-999");
});

test("list and search render the feed mode", async () => {
  const fx = await seedUserOrgProject("NC14");
  const ctx = makeAuthContext(fx.userId);
  await createOne(ctx, "PRJNC14", {
    title: "Injected guidance",
    type: "guidance",
    body: "constraint text",
    feedMode: "all",
  });
  await createOne(ctx, "PRJNC14", { title: "Plain reference" });

  const tree = okData<string>(
    await handleNote({ action: "list", project: "PRJNC14" }, ctx),
  );
  expect(tree).toContain("feed=all");

  const hits = okData<{ text: string }>(
    await handleNote(
      { action: "search", project: "PRJNC14", query: "constraint" },
      ctx,
    ),
  );
  expect(hits.text).toContain("feed=all");
});

test("read rejects heading combined with fields", async () => {
  const fx = await seedUserOrgProject("NC15");
  const ctx = makeAuthContext(fx.userId);
  const created = await createOne(ctx, "PRJNC15", {
    title: "Combo",
    body: "## Design\nplan",
  });

  const conflict = errText(
    await handleNote(
      {
        action: "read",
        note: created.ref,
        heading: "Design",
        fields: ["revisions"],
      },
      ctx,
    ),
  );
  expect(conflict).toContain("either heading");
});

/**
 * Mint an MCP-actor context, the shape the /api/mcp route produces. The
 * default `makeAuthContext(userId)` system actor doubles as the
 * non-agent control in the gate tests.
 *
 * @param userId - Verified user id.
 * @returns Auth context with an mcp actor.
 */
function agentCtx(userId: string): AuthContext {
  return makeAuthContext(userId, { source: "mcp", userId, clientId: null });
}

test("access-level matrix: agent writes follow §9.2, reads always work", async () => {
  const fx = await seedUserOrgProject("NG1");
  const ctx = makeAuthContext(fx.userId);
  const agent = agentCtx(fx.userId);

  const open = await createOne(agent, "PRJNG1", { title: "Open", body: "x" });
  const readOnly = await createOne(agent, "PRJNG1", {
    title: "Agent read only",
    body: "y",
  });
  const locked = await createOne(agent, "PRJNG1", {
    title: "Locked",
    body: "z",
  });
  const readOnlyId = await resolveId(ctx, fx, readOnly.ref);
  const lockedId = await resolveId(ctx, fx, locked.ref);
  await updateNote(ctx, readOnlyId, { agentWritable: false });
  await updateNote(ctx, lockedId, { locked: true });

  const editOf = (ref: string) =>
    handleNote(
      {
        action: "edit",
        note: ref,
        operations: [{ op: "append", field: "body", text: "more" }],
      },
      agent,
    );
  const moveOf = (ref: string) =>
    handleNote({ action: "move", note: ref, folder: "archive" }, agent);
  const deleteOf = (ref: string) =>
    handleNote({ action: "delete", note: ref, preview: false }, agent);

  expect((await editOf(open.ref)).ok).toBe(true);
  expect((await moveOf(open.ref)).ok).toBe(true);

  for (const op of [editOf, moveOf, deleteOf]) {
    const rejected = errText(await op(readOnly.ref));
    expect(rejected).toContain("read-only to agents");
    expect(rejected).toContain("ribbon");
    const lockedMsg = errText(await op(locked.ref));
    expect(lockedMsg).toContain("locked");
    expect(lockedMsg).toContain("unlock");
  }

  for (const ref of [readOnly.ref, locked.ref]) {
    const meta = okData<string>(
      await handleNote({ action: "read", note: ref }, agent),
    );
    expect(meta).toContain(ref);
  }
  const hits = okData<{ text: string }>(
    await handleNote(
      { action: "search", project: "PRJNG1", query: "agent" },
      agent,
    ),
  );
  expect(hits.text).toContain("Agent read only");

  const untouched = await getNoteFull(ctx, readOnlyId);
  expect(untouched.note.body).toBe("y");
  expect(untouched.note.folder).toBe("");
  expect((await getNoteFull(ctx, lockedId)).note.body).toBe("z");

  expect((await deleteOf(open.ref)).ok).toBe(true);
});

test("agent gate covers restore, links, and folder subtree moves; humans pass", async () => {
  const fx = await seedUserOrgProject("NG2");
  const ctx = makeAuthContext(fx.userId);
  const agent = agentCtx(fx.userId);
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "Anchor task",
    description: "Link target for the gate tests. Second sentence.",
  });

  const created = await createOne(agent, "PRJNG2", {
    title: "Guarded",
    folder: "kb",
  });
  const noteId = await resolveId(ctx, fx, created.ref);
  await updateNote(ctx, noteId, { agentWritable: false });

  const link = errText(
    await handleNote(
      { action: "link", note: created.ref, task: task.id, kind: "reference" },
      agent,
    ),
  );
  expect(link).toContain("read-only to agents");

  const subtree = errText(
    await handleNote(
      { action: "move", project: "PRJNG2", folder: "kb", destParent: "docs" },
      agent,
    ),
  );
  expect(subtree).toContain("read-only to agents");

  const humanMove = okData<{ dest: string; movedCount: number }>(
    await handleNote(
      { action: "move", project: "PRJNG2", folder: "kb", destParent: "docs" },
      ctx,
    ),
  );
  expect(humanMove.movedCount).toBe(1);

  await handleNote(
    { action: "delete", note: created.ref, preview: false },
    ctx,
  );
  const restore = errText(
    await handleNote({ action: "restore", note: noteId }, agent),
  );
  expect(restore).toContain("read-only to agents");
  expect((await handleNote({ action: "restore", note: noteId }, ctx)).ok).toBe(
    true,
  );
});

test("governance edit ops steer to request_share and the ribbon", async () => {
  const fx = await seedUserOrgProject("NG3");
  const agent = agentCtx(fx.userId);
  const created = await createOne(agent, "PRJNG3", { title: "Steered" });

  const visibility = errText(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        operations: [
          { op: "set", field: "visibility" as never, value: "team" },
        ],
      },
      agent,
    ),
  );
  expect(visibility).toContain("request_share");
  expect(visibility).toContain("human approval");

  const lockedField = errText(
    await handleNote(
      {
        action: "edit",
        note: created.ref,
        operations: [{ op: "set", field: "locked" as never, value: false }],
      },
      agent,
    ),
  );
  expect(lockedField).toContain("governance control");
});

test("request_share stays open to agents on read-only private notes", async () => {
  const fx = await seedUserOrgProject("NG4");
  const ctx = makeAuthContext(fx.userId);
  const agent = agentCtx(fx.userId);
  const privateNote = await createNote(ctx, {
    projectId: fx.projectId,
    title: "Private findings",
    visibility: "private",
  });
  await updateNote(ctx, privateNote.id, { agentWritable: false });

  const requested = okData<{ ref: string }>(
    await handleNote({ action: "request_share", note: privateNote.id }, agent),
  );
  expect(requested.ref).toBe(`PRJNG4-N${privateNote.sequenceNumber}`);

  const after = await getNoteFull(ctx, privateNote.id);
  expect(after.note.visibility).toBe("private");
  expect(after.note.shareRequestedBy).toBe(fx.userId);
});

test("a locked note in a subtree blocks folder moves for humans and agents", async () => {
  const fx = await seedUserOrgProject("NG5");
  const ctx = makeAuthContext(fx.userId);
  const agent = agentCtx(fx.userId);
  const created = await createOne(agent, "PRJNG5", {
    title: "Locked child",
    folder: "kb",
  });
  const noteId = await resolveId(ctx, fx, created.ref);
  await updateNote(ctx, noteId, { locked: true });

  for (const actor of [ctx, agent]) {
    const blocked = errText(
      await handleNote(
        { action: "move", project: "PRJNG5", folder: "kb", destParent: "docs" },
        actor,
      ),
    );
    expect(blocked).toContain("locked");
    expect(blocked).toContain("unlock");
  }

  expect((await getNoteFull(ctx, noteId)).note.folder).toBe("kb");
});

test("list shows explicit empty folders; folder moves hint only when nothing matched", async () => {
  const fx = await seedUserOrgProject("NC16");
  const ctx = makeAuthContext(fx.userId);
  await createNoteFolder(ctx, fx.projectId, "Research/empty");

  const tree = okData<string>(
    await handleNote({ action: "list", project: "PRJNC16" }, ctx),
  );
  expect(tree).toContain("Research/empty/");
  expect(tree).not.toContain("no notes yet");

  const renamed = okData<{
    dest: string;
    movedCount: number;
    explicitMoved: number;
    _hints?: string[];
  }>(
    await handleNote(
      {
        action: "move",
        project: "PRJNC16",
        folder: "Research/empty",
        destParent: "Research",
        newLeaf: "renamed",
      },
      ctx,
    ),
  );
  expect(renamed.dest).toBe("Research/renamed");
  expect(renamed.movedCount).toBe(0);
  expect(renamed.explicitMoved).toBe(1);
  expect(renamed._hints).toBeUndefined();

  const missing = okData<{
    movedCount: number;
    explicitMoved: number;
    _hints?: string[];
  }>(
    await handleNote(
      {
        action: "move",
        project: "PRJNC16",
        folder: "Ghost",
        destParent: "",
        newLeaf: "Spectre",
      },
      ctx,
    ),
  );
  expect(missing.movedCount).toBe(0);
  expect(missing.explicitMoved).toBe(0);
  expect(missing._hints?.[0]).toContain("no explicit folder");
});
