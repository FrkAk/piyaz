import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask, getTaskFull } from "@/lib/data/task";
import { handleCreate } from "@/lib/graph/tools/create";
import { handleEdit } from "@/lib/graph/tools/edit";
import { handleLink } from "@/lib/graph/tools/link";

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

/** Object payload shape returned by handleCreate. */
type CreatePayload = {
  created: { taskRef: string; id: string; title: string; key?: string }[];
  deduped: { taskRef: string; id: string; title: string }[];
  edges: number;
  _hints?: string[];
};

test("create resolves the project identifier and wires key edges", async () => {
  const fx = await seedUserOrgProject("TCREATE");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleCreate(
    {
      project: "PRJTCREATE",
      tasks: [
        {
          key: "a",
          title: "Build the parser",
          description: "Parses the input format. Feeds the renderer.",
        },
        {
          key: "b",
          title: "Build the renderer",
          description: "Renders parsed output. Consumes the parser.",
        },
      ],
      edges: [
        {
          source: "b",
          target: "a",
          type: "depends_on",
          note: "renderer consumes the parser's AST contract",
        },
      ],
    },
    ctx,
  );
  const data = okData<CreatePayload>(result);
  expect(data.created.map((c) => c.taskRef)).toEqual([
    "PRJTCREATE-1",
    "PRJTCREATE-2",
  ]);
  expect(data.edges).toBe(1);
});

test("create re-run dedups and says so in hints", async () => {
  const fx = await seedUserOrgProject("TCRDEDUP");
  const ctx = makeAuthContext(fx.userId);
  const payload = {
    project: "PRJTCRDEDUP",
    tasks: [
      {
        title: "Idempotent task",
        description: "First sentence here. Second sentence here.",
      },
    ],
  };

  const first = okData<CreatePayload>(await handleCreate(payload, ctx));
  expect(first.created).toHaveLength(1);

  const second = okData<CreatePayload>(await handleCreate(payload, ctx));
  expect(second.created).toHaveLength(0);
  expect(second.deduped).toHaveLength(1);
  expect(second._hints?.join(" ")).toContain("idempotent re-run");
});

test("create resolves taskRef edge endpoints to existing tasks", async () => {
  const fx = await seedUserOrgProject("TCRREF");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "Existing" });

  const result = await handleCreate(
    {
      project: "PRJTCRREF",
      tasks: [
        {
          key: "n",
          title: "Newcomer",
          description: "Builds on the existing task. Extends its contract.",
        },
      ],
      edges: [
        {
          source: "n",
          target: "PRJTCRREF-1",
          type: "depends_on",
          note: "extends the contract shipped by the existing task",
        },
      ],
    },
    ctx,
  );
  expect(okData<CreatePayload>(result).edges).toBe(1);
});

test("create rejects a taskRef-shaped item key", async () => {
  const fx = await seedUserOrgProject("TCRKEY");
  const result = await handleCreate(
    {
      project: "PRJTCRKEY",
      tasks: [
        {
          key: "ABC-1",
          title: "Bad key",
          description: "Has a ref-shaped key. Would be ambiguous in edges.",
        },
      ],
    },
    makeAuthContext(fx.userId),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("taskRef-shaped");
});

test("edit str_replace round-trips via ref and returns fresh updatedAt", async () => {
  const fx = await seedUserOrgProject("TEDITSR");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "Edit target",
    description: "The quick brown fox. Jumps over the lazy dog.",
  });

  const result = await handleEdit(
    {
      task: "PRJTEDITSR-1",
      operations: [
        {
          op: "str_replace",
          field: "description",
          oldStr: "quick brown fox",
          newStr: "slow green turtle",
        },
      ],
    },
    ctx,
  );
  const data = okData<{ id: string; applied: string[]; updatedAt: string }>(
    result,
  );
  expect(data.id).toBe(task.id);
  expect(data.applied.length).toBe(1);
  expect(new Date(data.updatedAt).getTime()).toBeGreaterThan(0);

  const persisted = await getTaskFull(ctx, task.id);
  expect(persisted.description).toContain("slow green turtle");
});

test("edit stale ifUpdatedAt names the current updatedAt", async () => {
  const fx = await seedUserOrgProject("TEDITSTALE");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Contended",
    description: "Two writers on this. One will lose.",
  });

  const result = await handleEdit(
    {
      task: "PRJTEDITSTALE-1",
      ifUpdatedAt: new Date(0).toISOString(),
      operations: [{ op: "set", field: "title", value: "New title" }],
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("changed since you last read it");
    expect(result.error).toContain("ifUpdatedAt");
  }
});

test("edit in_review status emits completion-protocol hints", async () => {
  const fx = await seedUserOrgProject("TEDITREV");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Ship me",
    description: "Work that goes to review. Without a PR attached.",
    status: "in_progress",
  });

  const result = await handleEdit(
    {
      task: "PRJTEDITREV-1",
      operations: [{ op: "set", field: "status", value: "in_review" }],
    },
    ctx,
  );
  const data = okData<{ _hints?: string[] }>(result);
  const hints = data._hints?.join(" ") ?? "";
  expect(hints).toContain("Missing executionRecord");
  expect(hints).toContain("prUrl");
  expect(hints).toContain("lens='review'");
});

test("edit delete_task previews with the prefer-cancelled hint", async () => {
  const fx = await seedUserOrgProject("TEDITDEL");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "Doomed" });

  const result = await handleEdit(
    {
      task: "PRJTEDITDEL-1",
      operations: [{ op: "delete_task" }],
    },
    ctx,
  );
  const data = okData<{ task: { id: string }; _hints?: string[] }>(result);
  expect(data.task.id).toBeDefined();
  expect(data._hints?.join(" ")).toContain("cancelled");
});

for (const placeholder of ["needed", "depends", "related", " Needed "]) {
  test(`link create rejects placeholder note "${placeholder}"`, async () => {
    const fx = await seedUserOrgProject("TLINKPH");
    const ctx = makeAuthContext(fx.userId);
    await createTask(ctx, { projectId: fx.projectId, title: "S" });
    await createTask(ctx, { projectId: fx.projectId, title: "T" });

    const result = await handleLink(
      {
        action: "create",
        source: "PRJTLINKPH-1",
        target: "PRJTLINKPH-2",
        type: "depends_on",
        note: placeholder,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Placeholder edge notes/i);
  });
}

test("link create accepts refs and a substantive note; duplicate says treat-as-success", async () => {
  const fx = await seedUserOrgProject("TLINKOK");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "S" });
  await createTask(ctx, { projectId: fx.projectId, title: "T" });

  const created = await handleLink(
    {
      action: "create",
      source: "PRJTLINKOK-1",
      target: "PRJTLINKOK-2",
      type: "depends_on",
      note: "Reuses the upload contract shipped by the target task.",
    },
    ctx,
  );
  expect(created.ok).toBe(true);

  const dup = await handleLink(
    {
      action: "create",
      source: "PRJTLINKOK-1",
      target: "PRJTLINKOK-2",
      type: "depends_on",
      note: "Reuses the upload contract shipped by the target task.",
    },
    ctx,
  );
  expect(dup.ok).toBe(false);
  if (!dup.ok) expect(dup.error).toContain("Treat as success");
});

test("link update by source+target+type changes the note", async () => {
  const fx = await seedUserOrgProject("TLINKUPD");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "S" });
  await createTask(ctx, { projectId: fx.projectId, title: "T" });
  await handleLink(
    {
      action: "create",
      source: "PRJTLINKUPD-1",
      target: "PRJTLINKUPD-2",
      type: "relates_to",
      note: "Shares the parser fixture set with the target.",
    },
    ctx,
  );

  const updated = await handleLink(
    {
      action: "update",
      source: "PRJTLINKUPD-1",
      target: "PRJTLINKUPD-2",
      type: "relates_to",
      note: "Shares the parser fixture set and the golden corpus.",
    },
    ctx,
  );
  const data = okData<{ note: string }>(updated);
  expect(data.note).toContain("golden corpus");
});

test("link remove requires a usable key", async () => {
  const fx = await seedUserOrgProject("TLINKRM");
  const result = await handleLink(
    { action: "remove" },
    makeAuthContext(fx.userId),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("source+target+type");
});

test("workspace create surfaces clean conflict on duplicate identifier", async () => {
  const fx = await seedUserOrgProject("TCONFLICT");
  const ctx = makeAuthContext(fx.userId);
  const sr = serviceRoleConnect();
  try {
    await sr`
      INSERT INTO projects ("organization_id", "title", "identifier")
      VALUES (${fx.organizationId}, 'Other', 'SMK')
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const { handleWorkspace } = await import("@/lib/graph/tools/workspace");
  const result = await handleWorkspace(
    {
      action: "create",
      title: "Smoke",
      identifier: "SMK",
      organizationId: fx.organizationId,
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/identifier already in use/i);
    expect(result.error).not.toMatch(/insert into|select .* from/i);
  }
});

test("create rejects placeholder edge notes before any write", async () => {
  const fx = await seedUserOrgProject("TEDGENOTE");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleCreate(
    {
      project: "PRJTEDGENOTE",
      tasks: [
        { key: "a", title: "A", description: "Does A. Feeds B." },
        { key: "b", title: "B", description: "Does B. Needs A." },
      ],
      edges: [
        { source: "b", target: "a", type: "depends_on", note: "depends" },
      ],
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  const error = (result as { ok: false; error: string }).error;
  expect(error).toContain("edges[0]");
  expect(error).toContain("Placeholder edge notes");
});

test("create rejects a non-UUID assigneeIds entry with corrective copy", async () => {
  const fx = await seedUserOrgProject("TASSIGNEE");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleCreate(
    {
      project: "PRJTASSIGNEE",
      tasks: [
        {
          title: "A",
          description: "Does A. Owned by someone.",
          assigneeIds: ["not-a-uuid"],
        },
      ],
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toContain(
    "'me' or a team-member user UUID",
  );
});

test("link update rejects placeholder and empty notes", async () => {
  const fx = await seedUserOrgProject("TLINKNOTE");
  const ctx = makeAuthContext(fx.userId);
  const a = await createTask(ctx, {
    projectId: fx.projectId,
    title: "A",
    description: "Does A.",
  });
  const b = await createTask(ctx, {
    projectId: fx.projectId,
    title: "B",
    description: "Does B.",
  });
  await handleLink(
    {
      action: "create",
      source: a.id,
      target: b.id,
      type: "depends_on",
      note: "A consumes B's parser contract",
    },
    ctx,
  );

  for (const note of ["needed", "  "]) {
    const result = await handleLink(
      {
        action: "update",
        source: a.id,
        target: b.id,
        type: "depends_on",
        note,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  }
});

test("key-addressed link update with type only steers to remove+create", async () => {
  const fx = await seedUserOrgProject("TLINKTYPE");
  const ctx = makeAuthContext(fx.userId);
  const a = await createTask(ctx, {
    projectId: fx.projectId,
    title: "A",
    description: "Does A.",
  });
  const b = await createTask(ctx, {
    projectId: fx.projectId,
    title: "B",
    description: "Does B.",
  });
  await handleLink(
    {
      action: "create",
      source: a.id,
      target: b.id,
      type: "depends_on",
      note: "A consumes B's parser contract",
    },
    ctx,
  );

  const result = await handleLink(
    { action: "update", source: a.id, target: b.id, type: "relates_to" },
    ctx,
  );
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toContain("note only");
});

test("edit with an unknown category names the vocabulary inline", async () => {
  const fx = await seedUserOrgProject("TCATCOPY");
  const ctx = makeAuthContext(fx.userId);
  const sr = serviceRoleConnect();
  try {
    await sr`
      UPDATE projects SET categories = ${JSON.stringify(["backend", "mcp"])}::jsonb
      WHERE id = ${fx.projectId}`;
  } finally {
    await sr.end({ timeout: 5 });
  }
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "T",
    description: "Categorizable task. Exists for the vocab test.",
  });

  const result = await handleEdit(
    {
      task: task.id,
      operations: [{ op: "set", field: "category", value: "zzz" }],
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  const error = (result as { ok: false; error: string }).error;
  expect(error).toContain("backend, mcp");
  expect(error).toContain("view='meta'");
});
