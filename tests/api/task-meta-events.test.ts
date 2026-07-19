import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { broker } from "@/lib/realtime/broker";
import type { RealtimeEvent } from "@/lib/realtime/types";
import { makeAuthContext } from "@/lib/auth/context";
import { addTaskLink, createTask } from "@/lib/data/task";
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
