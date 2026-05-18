import { test, expect, beforeEach, mock } from "bun:test";

/**
 * Bun runs tests in Node, so the `cloudflare:workers` virtual module and the
 * `WebSocketPair` global aren't present. Mock the base class as a no-op
 * abstract that exposes `ctx` / `env` set from the constructor, mirroring
 * the workerd shape `protected ctx: DurableObjectState`.
 */
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

/**
 * Minimal `WebSocketPair` stub. The upgrade path only forwards the server
 * end to `acceptWebSocket` and returns the client end on the Response;
 * neither needs real socket behavior for our assertions.
 */
(globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {
  0 = { __side: "client" } as unknown;
  1 = { __side: "server" } as unknown;
};

const { MymirBroker } = await import("@/lib/realtime/broker-do");

/** Fake socket with a captured `send` mock and the tags it was accepted with. */
type FakeSocket = {
  tags: string[];
  send: ReturnType<typeof mock>;
};

/**
 * Build a fake `DurableObjectState` that implements just the hibernation
 * surface the DO touches: `acceptWebSocket`, `getWebSockets(tag?)`, and
 * `getTags(ws)`.
 */
function fakeCtx() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    acceptWebSocket(ws: FakeSocket, tags: string[]) {
      ws.tags = tags;
      sockets.push(ws);
    },
    getWebSockets(tag?: string) {
      if (tag === undefined) return [...sockets];
      return sockets.filter((s) => s.tags.includes(tag));
    },
    getTags(ws: FakeSocket) {
      return ws.tags;
    },
  };
}

/** Construct a fresh fake socket with a send mock and unattached tags. */
function fakeSocket(): FakeSocket {
  return {
    tags: [],
    send: mock((_data: string) => {}),
  };
}

/** Build a `MymirBroker` with our fake ctx so we can poke its private hooks. */
function makeBroker() {
  const ctx = fakeCtx();
  const broker = new MymirBroker(ctx as never, {} as never);
  return { ctx, broker };
}

/** Helper to issue a JSON-body RPC against the DO. */
function rpc(broker: InstanceType<typeof MymirBroker>, body: unknown) {
  return broker.fetch(
    new Request("https://broker/", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

/** Attach a socket directly via the fake ctx for tests that skip the upgrade. */
function attach(ctx: ReturnType<typeof fakeCtx>, userId: string): FakeSocket {
  const ws = fakeSocket();
  ctx.acceptWebSocket(ws, [userId]);
  return ws;
}

beforeEach(() => {});

test("register then dispatch — reaches every socket of the registered user", async () => {
  const { ctx, broker } = makeBroker();
  const ws = attach(ctx, "u1");
  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  const r = await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { kind: "project", projectId: "p1" },
  });
  expect(r.status).toBe(204);
  const frame = `data: ${JSON.stringify({ kind: "project", projectId: "p1" })}\n\n`;
  expect(ws.send).toHaveBeenCalledWith(frame);
});

test("unregister — subsequent dispatch does not reach the user", async () => {
  const { ctx, broker } = makeBroker();
  const ws = attach(ctx, "u1");
  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  await rpc(broker, { op: "unregister", userId: "u1", key: "project:p1" });
  await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { ok: true },
  });
  expect(ws.send).not.toHaveBeenCalled();
});

test("clear-task-subs — drops task:* but preserves project:* and project-list:*", async () => {
  const { ctx, broker } = makeBroker();
  const ws = attach(ctx, "u1");
  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  await rpc(broker, { op: "register", userId: "u1", key: "project-list:u1" });
  await rpc(broker, {
    op: "register",
    userId: "u1",
    key: "task:t1",
    ttlMs: 60_000,
  });
  await rpc(broker, { op: "clear-task-subs", userId: "u1" });

  await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { kind: "project", projectId: "p1" },
  });
  await rpc(broker, {
    op: "dispatch",
    key: "project-list:u1",
    payload: { kind: "project-list", orgId: "o1" },
  });
  await rpc(broker, {
    op: "dispatch",
    key: "task:t1",
    payload: { kind: "task" },
  });

  expect(ws.send).toHaveBeenCalledTimes(2);
});

test("TTL expiry — expired entries are cleaned and not delivered", async () => {
  const { ctx, broker } = makeBroker();
  const ws = attach(ctx, "u1");
  await rpc(broker, {
    op: "register",
    userId: "u1",
    key: "task:t1",
    ttlMs: 5,
  });
  await new Promise((r) => setTimeout(r, 15));
  await rpc(broker, {
    op: "dispatch",
    key: "task:t1",
    payload: { kind: "task" },
  });
  expect(ws.send).not.toHaveBeenCalled();
});

test("WebSocket upgrade — missing X-Mymir-User-Id returns 400", async () => {
  const { broker } = makeBroker();
  const r = await broker.fetch(
    new Request("https://broker/", {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(r.status).toBe(400);
});

test("WebSocket upgrade — accepts when under cap, attaches with user tag", async () => {
  const { ctx, broker } = makeBroker();
  const r = await broker.fetch(
    new Request("https://broker/", {
      headers: { Upgrade: "websocket", "X-Mymir-User-Id": "u1" },
    }),
  );
  expect(r.status).toBe(101);
  expect(ctx.getWebSockets("u1").length).toBe(1);
});

test("WebSocket upgrade — 21st connection for same user returns 429", async () => {
  const { ctx, broker } = makeBroker();
  for (let i = 0; i < 20; i++) {
    const r = await broker.fetch(
      new Request("https://broker/", {
        headers: { Upgrade: "websocket", "X-Mymir-User-Id": "u1" },
      }),
    );
    expect(r.status).toBe(101);
  }
  const overflow = await broker.fetch(
    new Request("https://broker/", {
      headers: { Upgrade: "websocket", "X-Mymir-User-Id": "u1" },
    }),
  );
  expect(overflow.status).toBe(429);
  expect(ctx.getWebSockets("u1").length).toBe(20);
});

test("WebSocket upgrade — cap is scoped per user", async () => {
  const { ctx, broker } = makeBroker();
  for (let i = 0; i < 20; i++) {
    await broker.fetch(
      new Request("https://broker/", {
        headers: { Upgrade: "websocket", "X-Mymir-User-Id": "u1" },
      }),
    );
  }
  const other = await broker.fetch(
    new Request("https://broker/", {
      headers: { Upgrade: "websocket", "X-Mymir-User-Id": "u2" },
    }),
  );
  expect(other.status).toBe(101);
  expect(ctx.getWebSockets("u2").length).toBe(1);
});

test("malformed JSON body returns 400", async () => {
  const { broker } = makeBroker();
  const r = await rpc(broker, "not json");
  expect(r.status).toBe(400);
});

test("unknown op returns 400", async () => {
  const { broker } = makeBroker();
  const r = await rpc(broker, { op: "nope" });
  expect(r.status).toBe(400);
});

test("detach op is informational and returns 204", async () => {
  const { broker } = makeBroker();
  const r = await rpc(broker, { op: "detach", userId: "u1" });
  expect(r.status).toBe(204);
});

test("webSocketClose — last socket close clears the user's subs", async () => {
  const { ctx, broker } = makeBroker();
  const ws = attach(ctx, "u1");
  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  broker.webSocketClose(ws as never, 1000, "bye", true);

  const ws2 = attach(ctx, "u1");
  ctx.sockets.splice(ctx.sockets.indexOf(ws), 1);
  await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { ok: true },
  });
  expect(ws2.send).not.toHaveBeenCalled();
});

test("dispatch tolerates a throwing socket without dropping siblings", async () => {
  const { ctx, broker } = makeBroker();
  const bad = attach(ctx, "u1");
  bad.send = mock(() => {
    throw new Error("dead pipe");
  });
  const good = attach(ctx, "u1");
  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  const r = await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { ok: true },
  });
  expect(r.status).toBe(204);
  expect(good.send).toHaveBeenCalledTimes(1);
});
