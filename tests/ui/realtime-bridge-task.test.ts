import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { applyRealtimeEvent } from "@/components/providers/RealtimeBridge";
import type { MyTask } from "@/lib/data/views";
import { myTasksKeys, projectKeys, taskKeys } from "@/lib/query/keys";

const when = new Date("2026-07-01T10:00:00.000Z");
const PROJECT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";

/**
 * Build a full my-tasks row anchored at the given content clock.
 *
 * @param updatedAt - The row's `updatedAt`.
 * @returns A cached-list row for the shared task id.
 */
function myTaskRow(updatedAt: Date): MyTask {
  return {
    id: TASK,
    title: "T",
    status: "in_progress",
    category: null,
    tags: [],
    priority: null,
    estimate: null,
    order: 0,
    updatedAt,
    taskRef: "PJ-1",
    hasDescription: false,
    hasCriteria: false,
    state: "in_progress",
    project: { id: PROJECT, identifier: "PJ", title: "Proj", color: "#888" },
    upstreamCount: 0,
    downstreamCount: 0,
    blockedBy: null,
  };
}

/**
 * Seed a QueryClient with graph, my-tasks, and detail caches.
 *
 * @param updatedAt - Content clock for the cached my-tasks row.
 * @returns The seeded client.
 */
function seededClient(updatedAt: Date): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(projectKeys.graph(PROJECT), { tasks: [] });
  qc.setQueryData(myTasksKeys.list(), [myTaskRow(updatedAt)]);
  qc.setQueryData(taskKeys.detail(PROJECT, TASK), { id: TASK });
  return qc;
}

/**
 * Whether a cached query is currently invalidated.
 *
 * @param qc - The query client.
 * @param key - The query key.
 * @returns True when the query state is invalidated.
 */
function invalidated(qc: QueryClient, key: readonly unknown[]): boolean {
  return qc.getQueryState(key)?.isInvalidated === true;
}

/**
 * Encode a task realtime event.
 *
 * @param opts - Optional `updatedAt` and `metaChanged` payload fields.
 * @returns The JSON wire string.
 */
function taskEvent(opts: { updatedAt?: Date; metaChanged?: boolean }): string {
  return JSON.stringify({
    kind: "task",
    projectId: PROJECT,
    taskId: TASK,
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt.toISOString() } : {}),
    ...(opts.metaChanged !== undefined
      ? { metaChanged: opts.metaChanged }
      : {}),
  });
}

/**
 * Encode a project realtime event.
 *
 * @param metaChanged - Optional metaChanged payload field.
 * @returns The JSON wire string.
 */
function projectEvent(metaChanged?: boolean): string {
  return JSON.stringify({
    kind: "project",
    projectId: PROJECT,
    ...(metaChanged !== undefined ? { metaChanged } : {}),
  });
}

test("a project event with metaChanged false skips the graph and my-tasks refetches", async () => {
  const qc = seededClient(when);

  await applyRealtimeEvent(qc, projectEvent(false));

  expect(invalidated(qc, projectKeys.graph(PROJECT))).toBe(false);
  expect(invalidated(qc, myTasksKeys.list())).toBe(false);
});

test("a project event without the flag invalidates the graph and my-tasks list", async () => {
  const qc = seededClient(when);

  await applyRealtimeEvent(qc, projectEvent());

  expect(invalidated(qc, projectKeys.graph(PROJECT))).toBe(true);
  expect(invalidated(qc, myTasksKeys.list())).toBe(true);
});

test("a project event with metaChanged true invalidates the graph and my-tasks list", async () => {
  const qc = seededClient(when);

  await applyRealtimeEvent(qc, projectEvent(true));

  expect(invalidated(qc, projectKeys.graph(PROJECT))).toBe(true);
  expect(invalidated(qc, myTasksKeys.list())).toBe(true);
});

test("a metaChanged:false task event patches the cached my-tasks row in place", async () => {
  const qc = seededClient(when);
  const newer = new Date(when.getTime() + 60_000);

  await applyRealtimeEvent(
    qc,
    taskEvent({ updatedAt: newer, metaChanged: false }),
  );

  expect(invalidated(qc, myTasksKeys.list())).toBe(false);
  expect(invalidated(qc, taskKeys.detail(PROJECT, TASK))).toBe(true);
  const rows = qc.getQueryData<MyTask[]>(myTasksKeys.list());
  const patched = rows?.find((r) => r.id === TASK)?.updatedAt;
  expect(patched).toBeDefined();
  expect(
    typeof patched === "string" ? Date.parse(patched) : patched?.getTime(),
  ).toBe(newer.getTime());
});

test("the my-tasks patch never rewinds a newer cached row", async () => {
  const newerCache = new Date(when.getTime() + 120_000);
  const qc = seededClient(newerCache);
  const older = new Date(when.getTime() + 60_000);

  await applyRealtimeEvent(
    qc,
    taskEvent({ updatedAt: older, metaChanged: false }),
  );

  const rows = qc.getQueryData<MyTask[]>(myTasksKeys.list());
  expect(rows?.find((r) => r.id === TASK)?.updatedAt).toEqual(newerCache);
});

test("a metaChanged:true task event leaves the my-tasks patch to the paired project event", async () => {
  const qc = seededClient(when);
  const newer = new Date(when.getTime() + 60_000);

  await applyRealtimeEvent(
    qc,
    taskEvent({ updatedAt: newer, metaChanged: true }),
  );

  const rows = qc.getQueryData<MyTask[]>(myTasksKeys.list());
  expect(rows?.find((r) => r.id === TASK)?.updatedAt).toEqual(when);
  expect(invalidated(qc, taskKeys.detail(PROJECT, TASK))).toBe(true);
});
