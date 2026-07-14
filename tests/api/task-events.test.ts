import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { broker } from "@/lib/realtime/broker";
import { GET, HEAD } from "@/app/api/task/[taskId]/events/route";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask, updateTask } from "@/lib/data/task";
import type { ActivityEvent } from "@/lib/types";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  broker._resetForTests();
  await truncateAll();
});

/** Create a task and a second event (status change) so a page has two rows. */
async function seedTaskWithEvents(prefix: string) {
  const fx = await seedUserOrgProject(prefix);
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });
  await updateTask(ctx, task.id, { status: "in_progress" });
  return { fx, taskId: task.id };
}

const call = (
  taskId: string,
  query = "",
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
) =>
  (method === "HEAD" ? HEAD : GET)(
    new Request(`http://test/api/task/${taskId}/events${query}`, {
      method,
      headers,
    }),
    { params: Promise.resolve({ taskId }) },
  );

describe("GET /api/task/[taskId]/events", () => {
  test("a second request with the matching ETag returns 304 with no body", async () => {
    const { fx, taskId } = await seedTaskWithEvents("ev-etag");
    setSession({ user: { id: fx.userId } });

    const first = await call(taskId);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    const replay = await call(taskId, "", { "if-none-match": etag as string });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe("");

    await updateTask(makeAuthContext(fx.userId), taskId, { status: "done" });
    const after = await call(taskId, "", { "if-none-match": etag as string });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
  });

  test("HEAD returns the ETag and no body", async () => {
    const { fx, taskId } = await seedTaskWithEvents("ev-head");
    setSession({ user: { id: fx.userId } });

    const res = await call(taskId, "", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBeNull();
    expect(await res.text()).toBe("");
  });

  test("returns the owner's events newest-first with a 200", async () => {
    const { fx, taskId } = await seedTaskWithEvents("ev-owner");
    setSession({ user: { id: fx.userId } });

    const res = await call(taskId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: ActivityEvent[];
      nextCursor: string | null;
    };
    expect(body.events.map((e) => e.type)).toEqual([
      "status_changed",
      "task_created",
    ]);
    expect(body.nextCursor).toBeNull();
  });

  test("honors ?limit and returns a cursor for the next page", async () => {
    const { fx, taskId } = await seedTaskWithEvents("ev-limit");
    setSession({ user: { id: fx.userId } });

    const res = await call(taskId, "?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: ActivityEvent[];
      nextCursor: string | null;
    };
    expect(body.events).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
  });

  test("treats a malformed ?cursor as the first page (no 500)", async () => {
    const { fx, taskId } = await seedTaskWithEvents("ev-cursor");
    setSession({ user: { id: fx.userId } });

    const res = await call(taskId, "?cursor=not-a-cursor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: ActivityEvent[] };
    expect(body.events).toHaveLength(2);
  });

  test("returns 404 for a cross-team caller (no event leak in body)", async () => {
    const { taskId } = await seedTaskWithEvents("ev-owner-x");
    const stranger = await seedUserOrgProject("ev-stranger-x");
    setSession({ user: { id: stranger.userId } });

    const res = await call(taskId);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("status_changed");
  });

  test("returns 401 without a session", async () => {
    const { taskId } = await seedTaskWithEvents("ev-noauth");
    setSession(null);

    const res = await call(taskId);
    expect(res.status).toBe(401);
  });
});
