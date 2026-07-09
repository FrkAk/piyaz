import { afterEach, expect, spyOn, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask } from "@/tests/context/fixtures";
import { ForbiddenError } from "@/lib/auth/authorization";
import { makeAuthContext } from "@/lib/auth/context";
import * as rls from "@/lib/db/rls";
import {
  RecordNotTerminalError,
  resolveAgentBundleData,
  resolveDependencyClosure,
  resolvePlanningData,
  resolveRecordData,
  resolveWorkingData,
} from "@/lib/context/_core/bundle";
import { buildSummaryContext } from "@/lib/context/_core/summary";
import { buildReviewContext } from "@/lib/context/_core/review";
import { buildProjectOverview } from "@/lib/context/_core/overview";

afterEach(async () => {
  await truncateAll();
});

test("resolveDependencyClosure assembles task, walks, notes, and summaries", async () => {
  const fx = await seedRichContextTask("bundle-full");

  const closure = await resolveDependencyClosure(fx.userId, fx.taskId, "agent");

  expect(closure.task.id).toBe(fx.taskId);
  expect(closure.task.title).toBe("Central task");
  expect(closure.task.implementationPlan).toBe("Step one then step two");
  expect(closure.deps).toEqual([
    expect.objectContaining({ depth: 1 }) as never,
  ]);
  expect(closure.downstream).toEqual([
    expect.objectContaining({ depth: 1 }) as never,
  ]);
  expect(closure.depTasks.map((d) => d.title)).toEqual(["Prereq task"]);
  expect(closure.downstreamSummaries.map((d) => d.title)).toEqual([
    "Downstream task",
  ]);
  expect(closure.upstreamEdgeNotes.size).toBe(1);
  expect(closure.downstreamEdgeNotes.size).toBe(1);
});

test("resolveDependencyClosure resolves in two read batches for a connected task", async () => {
  const fx = await seedRichContextTask("bundle-batches");
  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    await resolveDependencyClosure(fx.userId, fx.taskId, "agent");
    expect(readSpy).toHaveBeenCalledTimes(2);
  } finally {
    readSpy.mockRestore();
  }
});

test("resolveDependencyClosure runs the feed as the sole second-batch statement for an isolated task", async () => {
  const fx = await seedUserOrgProject("bundle-isolated");
  const { superuserPool } = await import("@/tests/setup/global");
  const su = superuserPool();
  const [task] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number")
    VALUES (${fx.projectId}, 'Isolated task', 1)
    RETURNING id
  `;
  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    const closure = await resolveDependencyClosure(fx.userId, task.id, "agent");
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(closure.deps).toEqual([]);
    expect(closure.downstream).toEqual([]);
    expect(closure.depTasks).toEqual([]);
    expect(closure.feed.notes).toEqual([]);
  } finally {
    readSpy.mockRestore();
  }
});

test("resolveDependencyClosure throws ForbiddenError for a cross-tenant caller", async () => {
  const fx = await seedRichContextTask("bundle-owner");
  const stranger = await seedUserOrgProject("bundle-stranger");

  await expect(
    resolveDependencyClosure(stranger.userId, fx.taskId, "agent"),
  ).rejects.toThrow(ForbiddenError);
});

test("resolveDependencyClosure throws ForbiddenError for a malformed task id", async () => {
  const fx = await seedUserOrgProject("bundle-badid");

  await expect(
    resolveDependencyClosure(fx.userId, "not-a-uuid", "agent"),
  ).rejects.toThrow(ForbiddenError);
});

test("resolveDependencyClosure returns the depth-scoped closure", async () => {
  const fx = await seedRichContextTask("closure-agent");

  const closure = await resolveDependencyClosure(fx.userId, fx.taskId, "agent");

  expect(closure.task.id).toBe(fx.taskId);
  expect(closure.task.executionRecord).toBe("Built the thing");
  expect(closure.depTasks.map((d) => d.executionRecord)).toEqual([
    "Prereq execution record",
  ]);
  expect(closure.downstreamSummaries).toHaveLength(1);
});

test("resolvePlanningData includes the parent project header", async () => {
  const fx = await seedRichContextTask("closure-planning");

  const data = await resolvePlanningData(fx.userId, fx.taskId);

  expect(data.project?.title).toBe("Project closure-planning");
  expect(data.task.implementationPlan).toBe("Step one then step two");
  expect(data.abandonedDeps).toEqual([]);
});

test("resolvePlanningData surfaces direct cancelled deps with records", async () => {
  const fx = await seedRichContextTask("closure-abandoned");
  const sr = serviceRoleConnect();
  try {
    const [dead] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description, status, execution_record)
      SELECT project_id, 'Dead approach', 8, 'dropped', 'cancelled', 'Tried Z; failed'
      FROM tasks WHERE id = ${fx.taskId} RETURNING id`;
    await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
             VALUES (${fx.taskId}, ${dead.id}, 'depends_on', 'old route')`;
    await sr`INSERT INTO task_links (task_id, url, kind)
             VALUES (${dead.id}, 'https://example.test/pr/66', 'pull_request')`;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const data = await resolvePlanningData(fx.userId, fx.taskId);

  expect(data.abandonedDeps.map((d) => d.title)).toEqual(["Dead approach"]);
  expect(data.abandonedDeps[0].executionRecord).toBe("Tried Z; failed");
  expect(data.abandonedDeps[0].prUrl).toBe("https://example.test/pr/66");
  expect(data.deps.map((d) => d.id)).not.toContain(data.abandonedDeps[0].id);
});

test("resolvePlanningData surfaces cancelled deps without a rationale", async () => {
  const fx = await seedRichContextTask("closure-abandoned-bare");
  const sr = serviceRoleConnect();
  try {
    const [dead] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, description, status)
      SELECT project_id, 'Silent abandonment', 8, 'dropped', 'cancelled'
      FROM tasks WHERE id = ${fx.taskId} RETURNING id`;
    await sr`INSERT INTO task_edges (source_task_id, target_task_id, edge_type, note)
             VALUES (${fx.taskId}, ${dead.id}, 'depends_on', 'old route')`;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const data = await resolvePlanningData(fx.userId, fx.taskId);

  expect(data.abandonedDeps.map((d) => d.title)).toEqual([
    "Silent abandonment",
  ]);
  expect(data.abandonedDeps[0].executionRecord).toBeNull();
});

test("resolveRecordData resolves in two read batches and skips upstream data", async () => {
  const fx = await seedRichContextTask("record-slim");
  const sr = serviceRoleConnect();
  try {
    await sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`;
  } finally {
    await sr.end({ timeout: 5 });
  }
  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    const data = await resolveRecordData(fx.userId, fx.taskId);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(data.project?.title).toBe("Project record-slim");
    expect(data.downstreamSummaries.map((d) => d.title)).toEqual([
      "Downstream task",
    ]);
    expect(data.downstreamSummaries[0].description).toBe("");
    expect("depTasks" in data).toBe(false);
  } finally {
    readSpy.mockRestore();
  }
});

test("resolveRecordData rejects a non-terminal task (TOCTOU guard)", async () => {
  const fx = await seedRichContextTask("record-nonterminal");
  // The task is in_review (non-terminal); the resolver must refuse to render
  // a retrospective record even if a caller reached it, so a status flip
  // between the access gate and this fetch cannot serve a wrong bundle.
  await expect(resolveRecordData(fx.userId, fx.taskId)).rejects.toThrow(
    RecordNotTerminalError,
  );
});

test("agent-depth dispatch drops the implementation plan for terminal tasks", async () => {
  const fx = await seedRichContextTask("agent-terminal-plan");
  const sr = serviceRoleConnect();
  try {
    await sr`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`;
  } finally {
    await sr.end({ timeout: 5 });
  }
  const resolved = await resolveAgentBundleData(fx.userId, fx.taskId);
  expect(resolved.kind).toBe("record");
  // The `active-only` plan projection NULLs the column for terminal rows, so
  // the (often largest) implementationPlan never egresses on the done path.
  expect(resolved.data.task.implementationPlan).toBeNull();
});

test("resolveRecordData runs the feed as the sole second-batch statement without dependents", async () => {
  const fx = await seedUserOrgProject("record-isolated");
  const { superuserPool } = await import("@/tests/setup/global");
  const su = superuserPool();
  const [task] = await su<{ id: string }[]>`
    INSERT INTO tasks ("project_id", "title", "sequence_number", "status")
    VALUES (${fx.projectId}, 'Isolated done task', 1, 'done')
    RETURNING id
  `;
  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    const data = await resolveRecordData(fx.userId, task.id);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(data.downstream).toEqual([]);
    expect(data.downstreamSummaries).toEqual([]);
    expect(data.feed.notes).toEqual([]);
  } finally {
    readSpy.mockRestore();
  }
});

test("resolveWorkingData assembles detailed edges and ancestors", async () => {
  const fx = await seedRichContextTask("working-data");

  const data = await resolveWorkingData(fx.userId, fx.taskId);

  expect(data.task.id).toBe(fx.taskId);
  expect(data.detailedEdges).toHaveLength(3);
  const dependsOn = data.detailedEdges.filter(
    (e) => e.edgeType === "depends_on",
  );
  expect(dependsOn.map((e) => e.direction).sort()).toEqual([
    "incoming",
    "outgoing",
  ]);
  const related = data.detailedEdges.filter((e) => e.edgeType === "relates_to");
  expect(related).toHaveLength(1);
  expect(related[0].connectedTask.title).toBe("Related task");
  expect(data.ancestors).toEqual([
    expect.objectContaining({ type: "project", title: "Project working-data" }),
  ]);
});

test("buildSummaryContext resolves in read batches with no interactive frame", async () => {
  const fx = await seedRichContextTask("topo-summary");
  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    await buildSummaryContext(makeAuthContext(fx.userId), fx.taskId);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});

test("buildReviewContext resolves in read batches with no interactive frame", async () => {
  const fx = await seedRichContextTask("topo-review");
  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    await buildReviewContext(makeAuthContext(fx.userId), fx.taskId);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});

test("buildProjectOverview resolves in one read batch with no interactive frame", async () => {
  const fx = await seedRichContextTask("topo-overview");
  const { task } = await resolveWorkingData(fx.userId, fx.taskId);
  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    await buildProjectOverview(makeAuthContext(fx.userId), task.projectId);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});
