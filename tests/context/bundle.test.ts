import { afterEach, expect, spyOn, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { seedRichContextTask } from "@/tests/context/fixtures";
import { ForbiddenError } from "@/lib/auth/authorization";
import { makeAuthContext } from "@/lib/auth/context";
import * as rls from "@/lib/db/rls";
import {
  resolveDependencyClosure,
  resolvePlanningData,
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

test("resolveDependencyClosure skips the secondary batch for an isolated task", async () => {
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
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(closure.deps).toEqual([]);
    expect(closure.downstream).toEqual([]);
    expect(closure.depTasks).toEqual([]);
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
  } finally {
    await sr.end({ timeout: 5 });
  }

  const data = await resolvePlanningData(fx.userId, fx.taskId);

  expect(data.abandonedDeps.map((d) => d.title)).toEqual(["Dead approach"]);
  expect(data.abandonedDeps[0].executionRecord).toBe("Tried Z; failed");
  expect(data.deps.map((d) => d.id)).not.toContain(data.abandonedDeps[0].id);
});

test("resolveWorkingData assembles detailed edges and ancestors", async () => {
  const fx = await seedRichContextTask("working-data");

  const data = await resolveWorkingData(fx.userId, fx.taskId);

  expect(data.task.id).toBe(fx.taskId);
  expect(data.detailedEdges).toHaveLength(2);
  const directions = data.detailedEdges.map((e) => e.direction).sort();
  expect(directions).toEqual(["incoming", "outgoing"]);
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
