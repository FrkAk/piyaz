import { test, expect, beforeEach, mock } from "bun:test";
import { broker, MAX_CONNECTIONS_PER_USER } from "@/lib/realtime/broker";

beforeEach(() => {
  broker._resetForTests();
});

const fakeConn = () => ({
  send: mock((data: string) => {
    void data;
  }),
  close: mock(() => {}),
});

test("register without TTL — subscribers includes user indefinitely", () => {
  broker.register("u1", "project:p1");
  expect([...broker.subscribers("project:p1")]).toEqual(["u1"]);
});

test("register with TTL — expired subscriptions are skipped and lazy-cleaned", async () => {
  broker.register("u1", "task:t1", 5);
  await new Promise((r) => setTimeout(r, 10));
  expect([...broker.subscribers("task:t1")]).toEqual([]);
});

test("dispatch sends an SSE frame to every connection of every subscriber", () => {
  const c1 = fakeConn();
  const c2 = fakeConn();
  broker.register("u1", "project:p1");
  broker.attach("u1", c1);
  broker.attach("u1", c2);
  broker.dispatch("project:p1", { kind: "project", projectId: "p1" });
  const frame = `data: ${JSON.stringify({ kind: "project", projectId: "p1" })}\n\n`;
  expect(c1.send).toHaveBeenCalledWith(frame);
  expect(c2.send).toHaveBeenCalledWith(frame);
});

test("detach last connection — clears every subscription for the user", () => {
  const c1 = fakeConn();
  broker.register("u1", "project:p1");
  broker.register("u1", "task:t1", 60_000);
  broker.attach("u1", c1);
  broker.detach("u1", c1);
  expect([...broker.subscribers("project:p1")]).toEqual([]);
  expect([...broker.subscribers("task:t1")]).toEqual([]);
});

test("detach non-last connection — preserves subscriptions for remaining tabs", () => {
  const c1 = fakeConn();
  const c2 = fakeConn();
  broker.register("u1", "project:p1");
  broker.attach("u1", c1);
  broker.attach("u1", c2);
  broker.detach("u1", c1);
  expect([...broker.subscribers("project:p1")]).toEqual(["u1"]);
  broker.dispatch("project:p1", { ok: true });
  expect(c1.send).not.toHaveBeenCalled();
  expect(c2.send).toHaveBeenCalledTimes(1);
});

test("dispatch tolerates a throwing connection without dropping siblings", () => {
  const bad = fakeConn();
  bad.send = mock((data: string) => {
    void data;
    throw new Error("dead pipe");
  });
  const good = fakeConn();
  broker.register("u1", "project:p1");
  broker.attach("u1", bad);
  broker.attach("u1", good);
  expect(() =>
    broker.dispatch("project:p1", { kind: "project", projectId: "p1" }),
  ).not.toThrow();
  expect(good.send).toHaveBeenCalledTimes(1);
});

test("unregister drops a single subscription without affecting others", () => {
  broker.register("u1", "project:p1");
  broker.register("u1", "task:t1");
  broker.unregister("u1", "task:t1");
  expect([...broker.subscribers("project:p1")]).toEqual(["u1"]);
  expect([...broker.subscribers("task:t1")]).toEqual([]);
});

test("hasConnections — false before attach, true after, false after last detach", () => {
  expect(broker.hasConnections("u1")).toBe(false);
  const c1 = fakeConn();
  broker.attach("u1", c1);
  expect(broker.hasConnections("u1")).toBe(true);
  broker.detach("u1", c1);
  expect(broker.hasConnections("u1")).toBe(false);
});

test("isAtConnectionLimit — flips at the cap, stays true past it", () => {
  expect(broker.isAtConnectionLimit("u1")).toBe(false);
  for (let i = 0; i < MAX_CONNECTIONS_PER_USER - 1; i++) {
    broker.attach("u1", fakeConn());
  }
  expect(broker.isAtConnectionLimit("u1")).toBe(false);
  broker.attach("u1", fakeConn());
  expect(broker.isAtConnectionLimit("u1")).toBe(true);
});

test("isAtConnectionLimit — scoped per user", () => {
  for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
    broker.attach("u1", fakeConn());
  }
  expect(broker.isAtConnectionLimit("u1")).toBe(true);
  expect(broker.isAtConnectionLimit("u2")).toBe(false);
});
