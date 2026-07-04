import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { handleWorkspace } from "@/lib/graph/tools/workspace";
import { handleSearch } from "@/lib/graph/tools/search";
import { handleGet } from "@/lib/graph/tools/get";
import { handleMap } from "@/lib/graph/tools/map";
import { handleActivity } from "@/lib/graph/tools/activity";

afterEach(async () => {
  await truncateAll();
});

/**
 * Unwrap a successful ToolResult's data as a string.
 *
 * @param result - Handler result expected to be ok with string data.
 * @returns The data string.
 * @throws Error when the result is a failure.
 */
function okText(result: { ok: boolean }): string {
  expect(result.ok).toBe(true);
  return (result as { ok: true; data: unknown }).data as string;
}

test("workspace whoami names the caller and steers to projects", async () => {
  const fx = await seedUserOrgProject("TWHOAMI");
  const result = await handleWorkspace(
    { action: "whoami" },
    makeAuthContext(fx.userId),
  );
  const text = okText(result);
  expect(text).toContain(fx.userId);
  expect(text).toContain("piyaz_workspace action='projects'");
});

test("search requires at least one criterion", async () => {
  const fx = await seedUserOrgProject("TSEARCHCRIT");
  const result = await handleSearch({}, makeAuthContext(fx.userId));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("At least one search criterion");
  }
});

test("search never returns another org's tasks", async () => {
  const a = await seedUserOrgProject("TSEARCHA");
  const b = await seedUserOrgProject("TSEARCHB");
  await createTask(makeAuthContext(a.userId), {
    projectId: a.projectId,
    title: "IsolationProbeTask",
  });

  const result = await handleSearch(
    { query: "IsolationProbeTask" },
    makeAuthContext(b.userId),
  );
  const text = okText(result);
  expect(text).toContain("No results");
});

test("search scoped by project identifier carries derived state", async () => {
  const fx = await seedUserOrgProject("TSEARCHSC");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Scoped probe",
    status: "planned",
  });

  const result = await handleSearch(
    { project: "PRJTSEARCHSC", query: "Scoped probe" },
    ctx,
  );
  const text = okText(result);
  expect(text).toContain("`PRJTSEARCHSC-1`");
  expect(text).toContain("|ready]");
});

test("get requires exactly one of task or project", async () => {
  const fx = await seedUserOrgProject("TGETXOR");
  const ctx = makeAuthContext(fx.userId);
  for (const params of [{}, { task: "PYZ-1", project: "PYZ" }]) {
    const result = await handleGet(params, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exactly one");
  }
});

test("get fields returns only requested fields with ids and updatedAt", async () => {
  const fx = await seedUserOrgProject("TGETFIELDS");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Fields probe",
    description: "Secret description body.",
    implementationPlan: "Plan body here",
    acceptanceCriteria: [
      { id: crypto.randomUUID(), text: "It works end to end", checked: false },
    ],
  });

  const result = await handleGet(
    {
      task: "PRJTGETFIELDS-1",
      fields: ["implementationPlan", "acceptanceCriteria"],
    },
    ctx,
  );
  const text = okText(result);
  expect(text).toContain("Note on the content below.");
  expect(text).toContain("updatedAt:");
  expect(text).toContain("Plan body here");
  expect(text).toContain("It works end to end");
  expect(text).toMatch(/- \[ \] It works end to end `[0-9a-f-]{36}`/);
  expect(text).not.toContain("Secret description body");
});

test("get resolves a taskRef to the working lens by default", async () => {
  const fx = await seedUserOrgProject("TGETREF");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Ref probe",
    description: "Body of the ref probe.",
  });

  const result = await handleGet({ task: "prjtgetref-1" }, ctx);
  const text = okText(result);
  expect(text).toContain("Ref probe");
});

test("get near-miss ref names the max existing sequence", async () => {
  const fx = await seedUserOrgProject("TGETMISS");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "Only task" });

  const result = await handleGet({ task: "PRJTGETMISS-99" }, ctx);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("up to PRJTGETMISS-1");
    expect(result.error).toContain("piyaz_search");
  }
});

test("get record lens on an active task returns corrective copy", async () => {
  const fx = await seedUserOrgProject("TGETRECORD");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "Active" });

  const result = await handleGet(
    { task: "PRJTGETRECORD-1", lens: "record" },
    ctx,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("done/cancelled");
});

test("get project view=meta resolves the identifier", async () => {
  const fx = await seedUserOrgProject("TGETMETA");
  const result = await handleGet(
    { project: "PRJTGETMETA" },
    makeAuthContext(fx.userId),
  );
  const text = okText(result);
  expect(text).toContain("`PRJTGETMETA`");
  expect(text).toContain("Progress:");
});

test("get overview truncates status groups at the limit with search guidance", async () => {
  const fx = await seedUserOrgProject("TGETOV");
  const ctx = makeAuthContext(fx.userId);
  for (let i = 1; i <= 4; i++) {
    await createTask(ctx, { projectId: fx.projectId, title: `Task ${i}` });
  }
  const result = await handleGet(
    { project: "PRJTGETOV", view: "overview", limit: 2 },
    ctx,
  );
  const text = okText(result);
  expect(text).toContain("+2 more");
  expect(text).toContain("piyaz_search project='PRJTGETOV'");
  expect(result.ok && result.meta?.truncated).toBe(true);
});

test("map neighbors walks by ref and renders notes", async () => {
  const fx = await seedUserOrgProject("TMAPN");
  const ctx = makeAuthContext(fx.userId);
  const a = await createTask(ctx, { projectId: fx.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: fx.projectId, title: "B" });
  const sr = serviceRoleConnect();
  try {
    await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
             VALUES (${a.id}, ${b.id}, 'relates_to', 'shares the schema')`;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const result = await handleMap(
    { view: "neighbors", task: "PRJTMAPN-1" },
    ctx,
  );
  const text = okText(result);
  expect(text).toContain("hop 1");
  expect(text).toContain("`PRJTMAPN-2`");
  expect(text).toContain("shares the schema");
});

test("map project views resolve the identifier", async () => {
  const fx = await seedUserOrgProject("TMAPR");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Ready one",
    status: "planned",
  });
  const result = await handleMap({ view: "ready", project: "PRJTMAPR" }, ctx);
  const text = okText(result);
  expect(text).toContain("Ready one");
});

test("map views truncate at the limit with narrowing guidance", async () => {
  const fx = await seedUserOrgProject("TMAPLIM");
  const ctx = makeAuthContext(fx.userId);
  for (let i = 1; i <= 4; i++) {
    await createTask(ctx, {
      projectId: fx.projectId,
      title: `Ready ${i}`,
      status: "planned",
    });
  }

  const result = await handleMap(
    { view: "ready", project: "PRJTMAPLIM", limit: 2 },
    ctx,
  );
  const text = okText(result);
  expect(text).toContain("+2 more");
  expect(text).toContain("piyaz_search project='PRJTMAPLIM'");
  expect(result.ok && result.meta?.truncated).toBe(true);
});

test("activity requires exactly one of project or task", async () => {
  const fx = await seedUserOrgProject("TACTXOR");
  const result = await handleActivity({}, makeAuthContext(fx.userId));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("exactly one");
});

test("activity project feed pages by identifier and honors since", async () => {
  const fx = await seedUserOrgProject("TACTFEED");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "Event source" });

  const all = await handleActivity({ project: "PRJTACTFEED" }, ctx);
  expect(okText(all)).toContain("task_created");

  const future = new Date(Date.now() + 60_000).toISOString();
  const none = await handleActivity(
    { project: "PRJTACTFEED", since: future },
    ctx,
  );
  expect(okText(none)).toContain("No activity in range");
});

test("foreign-org project ref is 404-shaped across read tools", async () => {
  const a = await seedUserOrgProject("TRLSA");
  const b = await seedUserOrgProject("TRLSB");
  const ctxB = makeAuthContext(b.userId);

  const byUuid = await handleGet({ project: a.projectId }, ctxB);
  expect(byUuid.ok).toBe(false);
  if (!byUuid.ok) expect(byUuid.error).toContain("not found");

  const byRef = await handleActivity({ project: "PRJTRLSA" }, ctxB);
  expect(byRef.ok).toBe(false);
  if (!byRef.ok) expect(byRef.error).toContain("not found");
});

test("activity rejects a malformed since with corrective copy", async () => {
  const fx = await seedUserOrgProject("TSINCE");
  const result = await handleActivity(
    { project: "PRJTSINCE", since: "last tuesday" },
    makeAuthContext(fx.userId),
  );
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toContain(
    "not a valid timestamp",
  );
});

test("map empty states steer to view= shapes, not the removed type=", async () => {
  const fx = await seedUserOrgProject("TMAPHINT");
  const ctx = makeAuthContext(fx.userId);

  const ready = okText(
    await handleMap({ view: "ready", project: "PRJTMAPHINT" }, ctx),
  );
  expect(ready).toContain("piyaz_map view='plannable'");
  expect(ready).toContain("view='blocked'");
  expect(ready).not.toContain("type='");

  const plannable = okText(
    await handleMap({ view: "plannable", project: "PRJTMAPHINT" }, ctx),
  );
  expect(plannable).toContain("piyaz_map view='blocked'");
  expect(plannable).not.toContain("type='");
});
