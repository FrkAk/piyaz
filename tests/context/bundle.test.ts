import { afterEach, expect, spyOn, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { seedRichContextTask } from "@/tests/context/fixtures";
import { ForbiddenError } from "@/lib/auth/authorization";
import { makeAuthContext } from "@/lib/auth/context";
import * as rls from "@/lib/db/rls";
import {
  resolveContextBundle,
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

test("resolveContextBundle assembles task, closure, header, edges, ancestors", async () => {
  const fx = await seedRichContextTask("bundle-full");

  const bundle = await resolveContextBundle(fx.userId, fx.taskId);

  expect(bundle.task.id).toBe(fx.taskId);
  expect(bundle.task.title).toBe("Central task");
  expect(bundle.task.implementationPlan).toBe("Step one then step two");
  expect(bundle.deps).toHaveLength(1);
  expect(bundle.downstream).toHaveLength(1);
  expect(bundle.depTasks.map((d) => d.title)).toEqual(["Prereq task"]);
  expect(bundle.downstreamSummaries.map((d) => d.title)).toEqual([
    "Downstream task",
  ]);
  expect(bundle.upstreamEdgeNotes.size).toBe(1);
  expect(bundle.downstreamEdgeNotes.size).toBe(1);
  expect(bundle.project?.title).toBe("Project bundle-full");
  expect(bundle.detailedEdges).toHaveLength(2);
  expect(bundle.ancestors).toEqual([
    expect.objectContaining({ type: "project", title: "Project bundle-full" }),
  ]);
});

test("resolveContextBundle resolves in two read batches for a connected task", async () => {
  const fx = await seedRichContextTask("bundle-batches");
  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    await resolveContextBundle(fx.userId, fx.taskId);
    expect(readSpy).toHaveBeenCalledTimes(2);
  } finally {
    readSpy.mockRestore();
  }
});

test("resolveContextBundle skips the secondary batch for an isolated task", async () => {
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
    const bundle = await resolveContextBundle(fx.userId, task.id);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(bundle.deps).toEqual([]);
    expect(bundle.downstream).toEqual([]);
    expect(bundle.detailedEdges).toEqual([]);
  } finally {
    readSpy.mockRestore();
  }
});

test("resolveContextBundle throws ForbiddenError for a cross-tenant caller", async () => {
  const fx = await seedRichContextTask("bundle-owner");
  const stranger = await seedUserOrgProject("bundle-stranger");

  await expect(
    resolveContextBundle(stranger.userId, fx.taskId),
  ).rejects.toThrow(ForbiddenError);
});

test("resolveContextBundle throws ForbiddenError for a malformed task id", async () => {
  const fx = await seedUserOrgProject("bundle-badid");

  await expect(resolveContextBundle(fx.userId, "not-a-uuid")).rejects.toThrow(
    ForbiddenError,
  );
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
  const projectRows = await resolveContextBundle(fx.userId, fx.taskId);
  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    await buildProjectOverview(
      makeAuthContext(fx.userId),
      projectRows.task.projectId,
    );
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});
