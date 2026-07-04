import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask, getTaskFull } from "@/lib/data/task";
import { handleCreate } from "@/lib/graph/tools/create";
import { handleEdit } from "@/lib/graph/tools/edit";
import { handleLink } from "@/lib/graph/tools/link";
import { handleGet } from "@/lib/graph/tools/get";
import { handleWorkspace } from "@/lib/graph/tools/workspace";

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
 * Unwrap a successful ToolResult's data as a string.
 *
 * @param result - Handler result expected to be ok with string data.
 * @returns The data string.
 */
function okText(result: { ok: boolean }): string {
  expect(result.ok).toBe(true);
  return (result as { ok: true; data: unknown }).data as string;
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

test("a malformed url is an invalid-url error, never task-not-found", async () => {
  const fx = await seedUserOrgProject("TBADURL");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "T",
    description: "Exists and stays findable. The URL is the problem.",
  });

  const result = await handleEdit(
    {
      task: task.id,
      operations: [{ op: "add", collection: "links", url: "not a url" }],
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  const error = (result as { ok: false; error: string }).error;
  expect(error).toContain("Invalid url");
  expect(error).not.toContain("not found");
});

test("edit rejects op text exceeding the per-field cap before resolving the task", async () => {
  const fx = await seedUserOrgProject("TCAP");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleEdit(
    {
      task: "PRJTCAP-1",
      operations: [
        { op: "set", field: "description", text: "x".repeat(100_001) },
      ],
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("description text exceeds");
    expect(result.error).toContain("100000");
  }
});

test("edit set tags fires variant and taxonomy hints", async () => {
  const fx = await seedUserOrgProject("TEDITTAGS");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Vocabulary anchor",
    tags: ["frontend", "feature"],
  });
  await createTask(ctx, { projectId: fx.projectId, title: "Tag target" });

  const result = await handleEdit(
    {
      task: "PRJTEDITTAGS-2",
      operations: [{ op: "set", field: "tags", value: ["front-end"] }],
    },
    ctx,
  );
  const hints = okData<{ _hints?: string[] }>(result)._hints?.join(" ") ?? "";
  expect(hints).toContain('variant of existing "frontend"');
  expect(hints).toContain("work-type dimension");
});

test("edit set tags stays quiet on exact vocabulary reuse", async () => {
  const fx = await seedUserOrgProject("TEDITTAGQ");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Vocabulary anchor",
    tags: ["frontend", "feature"],
  });
  await createTask(ctx, { projectId: fx.projectId, title: "Tag target" });

  const result = await handleEdit(
    {
      task: "PRJTEDITTAGQ-2",
      operations: [
        { op: "set", field: "tags", value: ["feature", "frontend"] },
      ],
    },
    ctx,
  );
  const hints = okData<{ _hints?: string[] }>(result)._hints?.join(" ") ?? "";
  expect(hints).not.toContain("variant");
  expect(hints).not.toContain("work-type dimension");
});

test("workspace update persists every plain field", async () => {
  const fx = await seedUserOrgProject("TWSUPD");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleWorkspace(
    {
      action: "update",
      project: "PRJTWSUPD",
      title: "Updated project",
      description: "Covers the update path. Persists every plain field.",
      status: "active",
      categories: ["backend", "frontend"],
    },
    ctx,
  );
  const data = okData<{
    title: string;
    status: string;
    categories: string[];
    description: string;
  }>(result);
  expect(data.title).toBe("Updated project");
  expect(data.status).toBe("active");
  expect(data.categories).toEqual(["backend", "frontend"]);
  expect(data.description).toContain("Persists every plain field");
});

test("workspace update requires a project and at least one field", async () => {
  const fx = await seedUserOrgProject("TWSREQ");
  const ctx = makeAuthContext(fx.userId);

  const noProject = await handleWorkspace({ action: "update" }, ctx);
  expect(noProject.ok).toBe(false);
  if (!noProject.ok) expect(noProject.error).toContain("project required");

  const noFields = await handleWorkspace(
    { action: "update", project: "PRJTWSREQ" },
    ctx,
  );
  expect(noFields.ok).toBe(false);
  if (!noFields.ok) expect(noFields.error).toContain("at least one of");
});

test("workspace update rejects a malformed identifier before any write", async () => {
  const fx = await seedUserOrgProject("TWSBADID");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleWorkspace(
    {
      action: "update",
      project: "PRJTWSBADID",
      title: "Should not land",
      identifier: "bad!",
    },
    ctx,
  );
  expect(result.ok).toBe(false);

  const meta = okText(await handleGet({ project: "PRJTWSBADID" }, ctx));
  expect(meta).toContain("Project TWSBADID");
  expect(meta).not.toContain("Should not land");
});

test("workspace update renames the identifier and cascades taskRefs", async () => {
  const fx = await seedUserOrgProject("TWSREN");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Ref carrier",
    description: "Holds the first ref. Proves the rename cascade.",
  });

  const result = await handleWorkspace(
    { action: "update", project: "PRJTWSREN", identifier: "WSRENX" },
    ctx,
  );
  const data = okData<{ identifier: string; _hints?: string[] }>(result);
  expect(data.identifier).toBe("WSRENX");
  expect(data._hints?.join(" ")).toContain("no longer resolve");

  const renamed = await handleGet({ task: "WSRENX-1", lens: "summary" }, ctx);
  expect(okText(renamed)).toContain("Ref carrier");

  const stale = await handleGet({ task: "PRJTWSREN-1" }, ctx);
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error).toContain("not found");
});

test("workspace update applies field changes and a rename in one call", async () => {
  const fx = await seedUserOrgProject("TWSBOTH");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleWorkspace(
    {
      action: "update",
      project: "PRJTWSBOTH",
      title: "Both applied",
      identifier: "WSBOTH",
    },
    ctx,
  );
  const data = okData<{
    title: string;
    identifier: string;
    _hints?: string[];
  }>(result);
  expect(data.title).toBe("Both applied");
  expect(data.identifier).toBe("WSBOTH");
  expect(data._hints?.join(" ")).toContain("Renamed all task refs");
});

test("workspace update rename onto a taken identifier is a clean conflict", async () => {
  const fx = await seedUserOrgProject("TWSTAKEN");
  const ctx = makeAuthContext(fx.userId);
  const sr = serviceRoleConnect();
  try {
    await sr`
      INSERT INTO projects ("organization_id", "title", "identifier")
      VALUES (${fx.organizationId}, 'Occupant', 'WSTAKEN')
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const result = await handleWorkspace(
    { action: "update", project: "PRJTWSTAKEN", identifier: "WSTAKEN" },
    ctx,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toMatch(/identifier already in use/i);
    expect(result.error).not.toMatch(/insert into|select .* from/i);
  }
});

test("workspace update rename is refused for a member-role caller", async () => {
  const fx = await seedUserOrgProject("TWSROLE");
  const su = superuserPool();
  const [member] = await su<{ id: string }[]>`
    INSERT INTO piyaz_auth."user" ("name", "email", "emailVerified", "updatedAt")
    VALUES ('Member TWSROLE', 'member-twsrole@test.local', true, now())
    RETURNING id
  `;
  await su`
    INSERT INTO piyaz_auth."member" ("organizationId", "userId", "role", "createdAt")
    VALUES (${fx.organizationId}, ${member.id}, 'member', now())
  `;

  const result = await handleWorkspace(
    { action: "update", project: "PRJTWSROLE", identifier: "WSROLE" },
    makeAuthContext(member.id),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("only team admins");
});

test("workspace rename_category moves tasks with the vocabulary entry", async () => {
  const fx = await seedUserOrgProject("TWSCATREN");
  const ctx = makeAuthContext(fx.userId);
  await handleWorkspace(
    {
      action: "update",
      project: "PRJTWSCATREN",
      categories: ["backend", "frontend"],
    },
    ctx,
  );
  const moved = await createTask(ctx, {
    projectId: fx.projectId,
    title: "Backend task",
    category: "backend",
  });
  const kept = await createTask(ctx, {
    projectId: fx.projectId,
    title: "Frontend task",
    category: "frontend",
  });

  const result = await handleWorkspace(
    {
      action: "rename_category",
      project: "PRJTWSCATREN",
      category: "backend",
      newCategory: "platform",
    },
    ctx,
  );
  const data = okData<{ categories: string[]; _hints?: string[] }>(result);
  expect(data.categories).toEqual(["platform", "frontend"]);
  expect(data._hints?.join(" ")).toContain("view='meta'");

  expect((await getTaskFull(ctx, moved.id)).category).toBe("platform");
  expect((await getTaskFull(ctx, kept.id)).category).toBe("frontend");
});

test("workspace rename_category rejects unknown and colliding names", async () => {
  const fx = await seedUserOrgProject("TWSCATBAD");
  const ctx = makeAuthContext(fx.userId);
  await handleWorkspace(
    {
      action: "update",
      project: "PRJTWSCATBAD",
      categories: ["backend", "frontend"],
    },
    ctx,
  );

  const unknown = await handleWorkspace(
    {
      action: "rename_category",
      project: "PRJTWSCATBAD",
      category: "nope",
      newCategory: "platform",
    },
    ctx,
  );
  expect(unknown.ok).toBe(false);
  if (!unknown.ok)
    expect(unknown.error).toContain("not in this project's categories");

  const collide = await handleWorkspace(
    {
      action: "rename_category",
      project: "PRJTWSCATBAD",
      category: "backend",
      newCategory: "frontend",
    },
    ctx,
  );
  expect(collide.ok).toBe(false);
  if (!collide.ok) expect(collide.error).toContain("already exists");
});

test("workspace delete_category uncategorizes its tasks", async () => {
  const fx = await seedUserOrgProject("TWSCATDEL");
  const ctx = makeAuthContext(fx.userId);
  await handleWorkspace(
    {
      action: "update",
      project: "PRJTWSCATDEL",
      categories: ["backend", "frontend"],
    },
    ctx,
  );
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "Orphaned soon",
    category: "backend",
  });

  const result = await handleWorkspace(
    { action: "delete_category", project: "PRJTWSCATDEL", category: "backend" },
    ctx,
  );
  const data = okData<{
    deleted: string;
    categories: string[];
    _hints?: string[];
  }>(result);
  expect(data.deleted).toBe("backend");
  expect(data.categories).toEqual(["frontend"]);
  expect(data._hints?.join(" ")).toContain("category=null");

  expect((await getTaskFull(ctx, task.id)).category).toBeNull();
});

test("create in a brainstorming project hints to flip to decomposing", async () => {
  const fx = await seedUserOrgProject("TPHBRAIN");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleCreate(
    {
      project: "PRJTPHBRAIN",
      tasks: [
        {
          title: "First graph task",
          description: "Lands during scoping. Should trigger the phase hint.",
        },
      ],
    },
    ctx,
  );
  const data = okData<CreatePayload>(result);
  expect(data._hints?.join(" ")).toContain("status='decomposing'");
});

test("edit execution-status flip in a decomposing project hints to promote", async () => {
  const fx = await seedUserOrgProject("TPHDECOMP");
  const ctx = makeAuthContext(fx.userId);
  await handleWorkspace(
    { action: "update", project: "PRJTPHDECOMP", status: "decomposing" },
    ctx,
  );
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Eager task",
    description: "Started before the graph is complete. Tests the hint.",
    status: "planned",
  });

  const flip = await handleEdit(
    {
      task: "PRJTPHDECOMP-1",
      operations: [{ op: "set", field: "status", value: "in_progress" }],
    },
    ctx,
  );
  const flipHints = okData<{ _hints?: string[] }>(flip)._hints?.join(" ") ?? "";
  expect(flipHints).toContain("status='active'");

  const refine = await handleEdit(
    {
      task: "PRJTPHDECOMP-1",
      operations: [
        { op: "append", field: "description", text: "One more sentence." },
      ],
    },
    ctx,
  );
  const refineHints =
    okData<{ _hints?: string[] }>(refine)._hints?.join(" ") ?? "";
  expect(refineHints).not.toContain("'decomposing'");
});

test("active project emits no phase hints on edit", async () => {
  const fx = await seedUserOrgProject("TPHACTIVE");
  const ctx = makeAuthContext(fx.userId);
  await handleWorkspace(
    { action: "update", project: "PRJTPHACTIVE", status: "active" },
    ctx,
  );
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Normal task",
    description: "Regular execution work. No phase hint expected.",
    status: "planned",
  });

  const result = await handleEdit(
    {
      task: "PRJTPHACTIVE-1",
      operations: [{ op: "set", field: "status", value: "in_progress" }],
    },
    ctx,
  );
  const hints = okData<{ _hints?: string[] }>(result)._hints?.join(" ") ?? "";
  expect(hints).not.toContain("brainstorming");
  expect(hints).not.toContain("'decomposing'");
});

test("archived project blocks writes, allows reads, and reopens", async () => {
  const fx = await seedUserOrgProject("TPHARCH");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Frozen source",
    description: "Exists before archival. Edge source in the block test.",
  });
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Frozen target",
    description: "Exists before archival. Edge target in the block test.",
  });
  const archive = await handleWorkspace(
    {
      action: "update",
      project: "PRJTPHARCH",
      status: "archived",
      categories: ["backend"],
    },
    ctx,
  );
  expect(okData<{ _hints?: string[] }>(archive)._hints?.join(" ")).toContain(
    "read-only",
  );

  const blockedCreate = await handleCreate(
    {
      project: "PRJTPHARCH",
      tasks: [
        {
          title: "Too late",
          description: "Should never land. The project is archived.",
        },
      ],
    },
    ctx,
  );
  expect(blockedCreate.ok).toBe(false);
  if (!blockedCreate.ok) {
    expect(blockedCreate.error).toMatch(/archived/);
    expect(blockedCreate.error).toContain("status='active'");
  }

  const blockedEdit = await handleEdit(
    {
      task: "PRJTPHARCH-1",
      operations: [
        { op: "append", field: "description", text: "Another sentence." },
      ],
    },
    ctx,
  );
  expect(blockedEdit.ok).toBe(false);
  if (!blockedEdit.ok) expect(blockedEdit.error).toMatch(/archived/);

  const blockedLink = await handleLink(
    {
      action: "create",
      source: "PRJTPHARCH-1",
      target: "PRJTPHARCH-2",
      type: "depends_on",
      note: "source consumes the target's frozen output contract",
    },
    ctx,
  );
  expect(blockedLink.ok).toBe(false);
  if (!blockedLink.ok) expect(blockedLink.error).toMatch(/archived/);

  const previewDelete = await handleEdit(
    { task: "PRJTPHARCH-1", operations: [{ op: "delete_task" }] },
    ctx,
  );
  expect(previewDelete.ok).toBe(true);

  const blockedDelete = await handleEdit(
    {
      task: "PRJTPHARCH-1",
      operations: [{ op: "delete_task", preview: false }],
    },
    ctx,
  );
  expect(blockedDelete.ok).toBe(false);
  if (!blockedDelete.ok) expect(blockedDelete.error).toMatch(/archived/);

  const blockedRename = await handleWorkspace(
    {
      action: "rename_category",
      project: "PRJTPHARCH",
      category: "backend",
      newCategory: "platform",
    },
    ctx,
  );
  expect(blockedRename.ok).toBe(false);
  if (!blockedRename.ok) expect(blockedRename.error).toMatch(/archived/);

  const read = await handleGet({ task: "PRJTPHARCH-1" }, ctx);
  expect(read.ok).toBe(true);

  const reopen = await handleWorkspace(
    { action: "update", project: "PRJTPHARCH", status: "active" },
    ctx,
  );
  expect(reopen.ok).toBe(true);

  const editAfterReopen = await handleEdit(
    {
      task: "PRJTPHARCH-1",
      operations: [
        { op: "append", field: "description", text: "Thawed sentence." },
      ],
    },
    ctx,
  );
  expect(editAfterReopen.ok).toBe(true);
});

test("workspace status transitions emit jump and backward hints", async () => {
  const fx = await seedUserOrgProject("TPHTRANS");
  const ctx = makeAuthContext(fx.userId);

  const jump = await handleWorkspace(
    { action: "update", project: "PRJTPHTRANS", status: "archived" },
    ctx,
  );
  const jumpHints = okData<{ _hints?: string[] }>(jump)._hints?.join(" ") ?? "";
  expect(jumpHints).toContain("skipping");
  expect(jumpHints).toContain("read-only");

  const backward = await handleWorkspace(
    { action: "update", project: "PRJTPHTRANS", status: "brainstorming" },
    ctx,
  );
  expect(okData<{ _hints?: string[] }>(backward)._hints?.join(" ")).toContain(
    "moved backward",
  );
});

test("archived metadata-only workspace update is allowed and hinted", async () => {
  const fx = await seedUserOrgProject("TPHAMETA");
  const ctx = makeAuthContext(fx.userId);
  await handleWorkspace(
    { action: "update", project: "PRJTPHAMETA", status: "archived" },
    ctx,
  );

  const result = await handleWorkspace(
    {
      action: "update",
      project: "PRJTPHAMETA",
      title: "Renamed while frozen",
    },
    ctx,
  );
  const data = okData<{ title: string; _hints?: string[] }>(result);
  expect(data.title).toBe("Renamed while frozen");
  expect(data._hints?.join(" ")).toContain("archived");

  const rename = await handleWorkspace(
    { action: "update", project: "PRJTPHAMETA", identifier: "PHAMETA2" },
    ctx,
  );
  const renameData = okData<{ identifier: string; _hints?: string[] }>(rename);
  expect(renameData.identifier).toBe("PHAMETA2");
  expect(renameData._hints?.join(" ")).toContain("archived");
});

test("edit by-id op on an empty collection names the op='add' recovery", async () => {
  const fx = await seedUserOrgProject("TEDITEMPTYCOLL");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, {
    projectId: fx.projectId,
    title: "No criteria yet",
  });

  const result = await handleEdit(
    {
      task: task.id,
      operations: [
        {
          op: "check",
          collection: "acceptanceCriteria",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ],
    },
    ctx,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("has no acceptanceCriteria items yet");
    expect(result.error).toContain("op='add' collection='acceptanceCriteria'");
  }
});

test("create suppresses the orphan-edges hint when there is nothing to wire to", async () => {
  const fx = await seedUserOrgProject("TCRORPH1");
  const ctx = makeAuthContext(fx.userId);

  const result = await handleCreate(
    {
      project: "PRJTCRORPH1",
      tasks: [
        {
          title: "First and only task",
          description: "Opens the project. Nothing exists to depend on yet.",
        },
      ],
    },
    ctx,
  );
  const data = okData<CreatePayload>(result);
  expect(data.created).toHaveLength(1);
  expect(data._hints?.join(" ") ?? "").not.toContain("No edges in this batch");
});

test("create keeps the orphan-edges hint when the batch or project has wiring targets", async () => {
  const fx = await seedUserOrgProject("TCRORPH2");
  const ctx = makeAuthContext(fx.userId);

  const pair = await handleCreate(
    {
      project: "PRJTCRORPH2",
      tasks: [
        {
          title: "Parser",
          description: "Parses the input. Feeds the renderer.",
        },
        {
          title: "Renderer",
          description: "Renders parser output. Depends on the parser.",
        },
      ],
    },
    ctx,
  );
  const pairData = okData<CreatePayload>(pair);
  expect(pairData._hints?.join(" ")).toContain("No edges in this batch");

  const single = await handleCreate(
    {
      project: "PRJTCRORPH2",
      tasks: [
        {
          title: "Late addition",
          description: "Lands after the graph exists. Should get wired in.",
        },
      ],
    },
    ctx,
  );
  const singleData = okData<CreatePayload>(single);
  expect(singleData._hints?.join(" ")).toContain("No edges in this batch");
});
