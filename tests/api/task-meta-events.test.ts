import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedSecondMember, seedUserOrgProject } from "@/tests/setup/seed";
import { broker } from "@/lib/realtime/broker";
import type { RealtimeEvent } from "@/lib/realtime/types";
import { makeAuthContext } from "@/lib/auth/context";
import { addTaskLink, createTask, updateTask } from "@/lib/data/task";
import { getProjectGraphSlim } from "@/lib/data/project";
import { applyTaskEdit } from "@/lib/data/task-edit";
import { createEdge, updateEdge } from "@/lib/data/edge";

afterEach(async () => {
  broker._resetForTests();
  await truncateAll();
});

/**
 * Decode captured SSE frames into realtime events.
 *
 * @param frames - Raw `data: <json>` frames from the fake connection.
 * @returns The decoded events.
 */
function eventsFrom(frames: string[]): RealtimeEvent[] {
  return frames.map(
    (f) => JSON.parse(f.slice("data: ".length)) as RealtimeEvent,
  );
}

test("task and project events carry metaChanged false on heavy writes and true on slim writes", async () => {
  const fx = await seedUserOrgProject("task-meta-ev");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });

  const frames: string[] = [];
  broker.attach(fx.userId, {
    send: (data) => frames.push(data),
    close: () => {},
  });
  broker.register(fx.userId, `project:${fx.projectId}`);
  broker.register(fx.userId, `task:${task.id}`);

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "implementationPlan", value: "plan body" },
  ]);
  await addTaskLink(ctx, task.id, "https://example.com/spec");
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "status", value: "planned" },
  ]);

  const evs = eventsFrom(frames);
  const taskEvs = evs.filter(
    (e): e is Extract<RealtimeEvent, { kind: "task" }> => e.kind === "task",
  );
  const projEvs = evs.filter(
    (e): e is Extract<RealtimeEvent, { kind: "project" }> =>
      e.kind === "project",
  );
  expect(taskEvs.map((e) => e.metaChanged)).toEqual([false, false, true]);
  expect(projEvs.map((e) => e.metaChanged)).toEqual([false, false, true]);
  for (const ev of taskEvs) expect(ev.updatedAt).toBeDefined();
  for (const ev of projEvs) {
    expect(ev.taskId).toBe(task.id);
    expect(ev.updatedAt).toBeDefined();
  }
});

test("state-neutral slim writes carry a patch snapshot; status and heavy writes do not", async () => {
  const fx = await seedUserOrgProject("task-patch-ev");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });

  const frames: string[] = [];
  broker.attach(fx.userId, {
    send: (data) => frames.push(data),
    close: () => {},
  });
  broker.register(fx.userId, `project:${fx.projectId}`);

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "title", value: "T2" },
    { op: "set", field: "priority", value: "core" },
    { op: "set", field: "tags", value: ["feature"] },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "executionRecord", value: "record body" },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "status", value: "planned" },
  ]);
  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "implementationPlan", value: "plan body" },
  ]);

  const projEvs = eventsFrom(frames).filter(
    (e): e is Extract<RealtimeEvent, { kind: "project" }> =>
      e.kind === "project",
  );
  expect(projEvs).toHaveLength(4);

  expect(projEvs[0].metaChanged).toBe(true);
  expect(projEvs[0].patch).toMatchObject({
    title: "T2",
    priority: "core",
    tags: ["feature"],
    hasExecutionRecord: false,
  });

  expect(projEvs[1].metaChanged).toBe(true);
  expect(projEvs[1].patch).toMatchObject({ hasExecutionRecord: true });

  expect(projEvs[2].metaChanged).toBe(true);
  expect(projEvs[2].patch).toBeUndefined();

  expect(projEvs[3].metaChanged).toBe(false);
  expect(projEvs[3].patch).toBeUndefined();
});

test("assignee-set changes ride the patch; criteria presence flips do not", async () => {
  const fx = await seedUserOrgProject("task-assign-ev");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });

  const frames: string[] = [];
  broker.attach(fx.userId, {
    send: (data) => frames.push(data),
    close: () => {},
  });
  broker.register(fx.userId, `project:${fx.projectId}`);

  await updateTask(ctx, task.id, { assigneeIds: [fx.userId] });
  await updateTask(ctx, task.id, { acceptanceCriteria: ["First criterion"] });

  const projEvs = eventsFrom(frames).filter(
    (e): e is Extract<RealtimeEvent, { kind: "project" }> =>
      e.kind === "project",
  );
  expect(projEvs).toHaveLength(2);

  expect(projEvs[0].metaChanged).toBe(true);
  expect(projEvs[0].patch).toMatchObject({
    assigneeUserIds: [fx.userId],
    assigneeCount: 1,
  });

  expect(projEvs[1].metaChanged).toBe(true);
  expect(projEvs[1].patch).toBeUndefined();
});

test("a write that restates an unchanged assignee set omits it from the patch", async () => {
  const fx = await seedUserOrgProject("task-assign-noop");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });
  await updateTask(ctx, task.id, { assigneeIds: [fx.userId] });

  const frames: string[] = [];
  broker.attach(fx.userId, {
    send: (data) => frames.push(data),
    close: () => {},
  });
  broker.register(fx.userId, `project:${fx.projectId}`);

  await updateTask(
    ctx,
    task.id,
    { title: "T2", assigneeIds: [fx.userId] },
    true,
  );

  const projEvs = eventsFrom(frames).filter(
    (e): e is Extract<RealtimeEvent, { kind: "project" }> =>
      e.kind === "project",
  );
  expect(projEvs).toHaveLength(1);
  expect(projEvs[0].patch).toMatchObject({ title: "T2" });
  expect(projEvs[0].patch?.assigneeUserIds).toBeUndefined();
  expect(projEvs[0].patch?.assigneeCount).toBeUndefined();
});

test("the patch assignee ids match the slim payload's ordered projection", async () => {
  const fx = await seedUserOrgProject("task-assign-order");
  const ctx = makeAuthContext(fx.userId);
  const other = await seedSecondMember(fx.organizationId, "assignorder");
  const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });

  const frames: string[] = [];
  broker.attach(fx.userId, {
    send: (data) => frames.push(data),
    close: () => {},
  });
  broker.register(fx.userId, `project:${fx.projectId}`);

  const ids = [fx.userId, other].sort((a, b) => (a < b ? 1 : -1));
  await updateTask(ctx, task.id, { assigneeIds: ids }, true);

  const projEv = eventsFrom(frames).find(
    (e): e is Extract<RealtimeEvent, { kind: "project" }> =>
      e.kind === "project",
  );
  const graph = await getProjectGraphSlim(ctx, fx.projectId);
  const row = graph.tasks.find((t) => t.id === task.id);
  expect(projEv?.patch?.assigneeUserIds).toEqual(row?.assigneeUserIds);
});

test("edge note-only updates emit metaChanged false; type changes emit true", async () => {
  const fx = await seedUserOrgProject("edge-meta-ev");
  const ctx = makeAuthContext(fx.userId);
  const a = await createTask(ctx, { projectId: fx.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: fx.projectId, title: "B" });
  const edge = await createEdge(ctx, {
    sourceTaskId: a.id,
    targetTaskId: b.id,
    edgeType: "relates_to",
  });

  const frames: string[] = [];
  broker.attach(fx.userId, {
    send: (data) => frames.push(data),
    close: () => {},
  });
  broker.register(fx.userId, `project:${fx.projectId}`);
  broker.register(fx.userId, `task:${a.id}`);
  broker.register(fx.userId, `task:${b.id}`);

  await updateEdge(ctx, edge.id, { note: "Rewritten note body" });
  await updateEdge(ctx, edge.id, { edgeType: "depends_on" });

  const evs = eventsFrom(frames);
  const flags = evs.map((e) =>
    e.kind === "task" || e.kind === "project" ? e.metaChanged : undefined,
  );
  expect(flags).toEqual([false, false, false, true, true, true]);
});
