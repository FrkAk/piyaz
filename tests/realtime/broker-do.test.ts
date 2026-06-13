import { test, expect, beforeEach, mock } from "bun:test";
import {
  BROKER_SIG_HEADER,
  BROKER_USER_ID_HEADER,
  buildNonceHex,
  buildSigningString,
  hmacSha256Hex,
  sha256Hex,
} from "@/lib/realtime/broker-auth";

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

const TEST_SECRET = "test-broker-secret";

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

/** Build a `MymirBroker` with our fake ctx and the test secret bound. */
function makeBroker(
  env: { BROKER_DO_SECRET?: string } = {
    BROKER_DO_SECRET: TEST_SECRET,
  },
) {
  const ctx = fakeCtx();
  const broker = new MymirBroker(ctx as never, env as never);
  return { ctx, broker };
}

/**
 * Sign and dispatch a JSON-body RPC. Mirrors the production adapter so
 * tests exercise the same code path the DO sees in workerd.
 */
async function rpc(
  broker: InstanceType<typeof MymirBroker>,
  body: unknown,
  opts?: { secret?: string; tsOverride?: number },
) {
  const secret = opts?.secret ?? TEST_SECRET;
  const ts = opts?.tsOverride ?? Date.now();
  const nonce = buildNonceHex();
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const bodyHashHex = await sha256Hex(text);
  const signingString = buildSigningString(
    "POST",
    "/",
    ts,
    nonce,
    bodyHashHex,
    "",
  );
  const signature = await hmacSha256Hex(secret, signingString);
  return broker.fetch(
    new Request("https://broker/", {
      method: "POST",
      body: text,
      headers: {
        "content-type": "application/json",
        [BROKER_SIG_HEADER]: `t=${ts},n=${nonce},v=${signature}`,
      },
    }),
  );
}

/**
 * Sign and dispatch a WebSocket upgrade. Carries the userId header inside
 * the signing input so an unsigned `X-Mymir-User-Id` swap cannot reach the
 * DO.
 */
async function upgrade(
  broker: InstanceType<typeof MymirBroker>,
  userId: string,
  opts?: { secret?: string },
) {
  const secret = opts?.secret ?? TEST_SECRET;
  const ts = Date.now();
  const nonce = buildNonceHex();
  const bodyHashHex = await sha256Hex("");
  const signingString = buildSigningString(
    "GET",
    "/",
    ts,
    nonce,
    bodyHashHex,
    userId,
  );
  const signature = await hmacSha256Hex(secret, signingString);
  return broker.fetch(
    new Request("https://broker/", {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        [BROKER_USER_ID_HEADER]: userId,
        [BROKER_SIG_HEADER]: `t=${ts},n=${nonce},v=${signature}`,
      },
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

test("clear-task-subs — drops every task:* key when many are registered", async () => {
  const { ctx, broker } = makeBroker();
  const ws = attach(ctx, "u1");
  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  await rpc(broker, { op: "register", userId: "u1", key: "project:p2" });
  await rpc(broker, { op: "register", userId: "u1", key: "project-list:u1" });
  for (let i = 1; i <= 5; i++) {
    await rpc(broker, {
      op: "register",
      userId: "u1",
      key: `task:t${i}`,
    });
  }

  await rpc(broker, { op: "clear-task-subs", userId: "u1" });

  for (let i = 1; i <= 5; i++) {
    await rpc(broker, {
      op: "dispatch",
      key: `task:t${i}`,
      payload: { kind: "task" },
    });
  }
  expect(ws.send).not.toHaveBeenCalled();

  await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { kind: "project", projectId: "p1" },
  });
  await rpc(broker, {
    op: "dispatch",
    key: "project:p2",
    payload: { kind: "project", projectId: "p2" },
  });
  await rpc(broker, {
    op: "dispatch",
    key: "project-list:u1",
    payload: { kind: "project-list", orgId: "o1" },
  });
  expect(ws.send).toHaveBeenCalledTimes(3);
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
  // Sign with userId="" so the envelope passes; the handler then sees the
  // missing header and answers 400.
  const r = await upgrade(broker, "");
  expect(r.status).toBe(400);
});

test("WebSocket upgrade — accepts when under cap, attaches with user tag", async () => {
  const { ctx, broker } = makeBroker();
  const r = await upgrade(broker, "u1");
  expect(r.status).toBe(101);
  expect(ctx.getWebSockets("u1").length).toBe(1);
});

test("WebSocket upgrade — 21st connection for same user returns 429", async () => {
  const { ctx, broker } = makeBroker();
  for (let i = 0; i < 20; i++) {
    const r = await upgrade(broker, "u1");
    expect(r.status).toBe(101);
  }
  const overflow = await upgrade(broker, "u1");
  expect(overflow.status).toBe(429);
  expect(ctx.getWebSockets("u1").length).toBe(20);
});

test("WebSocket upgrade — cap is scoped per user", async () => {
  const { ctx, broker } = makeBroker();
  for (let i = 0; i < 20; i++) {
    await upgrade(broker, "u1");
  }
  const other = await upgrade(broker, "u2");
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
  // Model the workerd hibernation contract: the closing socket is removed
  // from getWebSockets() before webSocketClose() runs.
  ctx.sockets.splice(ctx.sockets.indexOf(ws), 1);
  broker.webSocketClose(ws as never, 1000, "bye", true);

  const ws2 = attach(ctx, "u1");
  await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { ok: true },
  });
  expect(ws2.send).not.toHaveBeenCalled();
});

test("webSocketClose — preserves subs while other sockets remain live", async () => {
  const { ctx, broker } = makeBroker();
  const ws1 = attach(ctx, "u1");
  const ws2 = attach(ctx, "u1");
  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  // Close ws1 with ws2 still attached. Workerd removes the closing socket
  // before the callback fires, so ctx.sockets only contains ws2.
  ctx.sockets.splice(ctx.sockets.indexOf(ws1), 1);
  broker.webSocketClose(ws1 as never, 1000, "bye", true);

  await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { ok: true },
  });
  expect(ws2.send).toHaveBeenCalledTimes(1);
});

test("rejects unsigned RPC with 401", async () => {
  const { broker } = makeBroker();
  const r = await broker.fetch(
    new Request("https://broker/", {
      method: "POST",
      body: JSON.stringify({ op: "detach", userId: "u1" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(r.status).toBe(401);
});

test("rejects RPC signed with wrong secret with 401", async () => {
  const { broker } = makeBroker();
  const r = await rpc(
    broker,
    { op: "detach", userId: "u1" },
    { secret: "wrong-secret" },
  );
  expect(r.status).toBe(401);
});

test("rejects RPC with stale timestamp with 401", async () => {
  const { broker } = makeBroker();
  const stale = Date.now() - 120_000;
  const r = await rpc(
    broker,
    { op: "detach", userId: "u1" },
    { tsOverride: stale },
  );
  expect(r.status).toBe(401);
});

test("returns 503 when DO has no secret bound", async () => {
  const { broker } = makeBroker({});
  const r = await rpc(broker, { op: "detach", userId: "u1" });
  expect(r.status).toBe(503);
});

test("WebSocket upgrade with tampered userId rejected with 401", async () => {
  const { broker } = makeBroker();
  // Sign for userId="u1" then swap the header to "u2" — signature should
  // no longer verify because userId is folded into the signing input.
  const ts = Date.now();
  const nonce = buildNonceHex();
  const bodyHashHex = await sha256Hex("");
  const signingString = buildSigningString(
    "GET",
    "/",
    ts,
    nonce,
    bodyHashHex,
    "u1",
  );
  const signature = await hmacSha256Hex(TEST_SECRET, signingString);
  const r = await broker.fetch(
    new Request("https://broker/", {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        [BROKER_USER_ID_HEADER]: "u2",
        [BROKER_SIG_HEADER]: `t=${ts},n=${nonce},v=${signature}`,
      },
    }),
  );
  expect(r.status).toBe(401);
});

test("dispatch-many — fans out to every subscriber in one call", async () => {
  const { ctx, broker } = makeBroker();
  const w1 = attach(ctx, "u1");
  const w2 = attach(ctx, "u2");
  await rpc(broker, { op: "register", userId: "u1", key: "project-list:u1" });
  await rpc(broker, { op: "register", userId: "u2", key: "project-list:u2" });

  const r = await rpc(broker, {
    op: "dispatch-many",
    items: [
      {
        key: "project-list:u1",
        payload: { kind: "project-list", orgId: "o1" },
      },
      {
        key: "project-list:u2",
        payload: { kind: "project-list", orgId: "o1" },
      },
    ],
  });
  expect(r.status).toBe(204);
  expect(w1.send).toHaveBeenCalledTimes(1);
  expect(w2.send).toHaveBeenCalledTimes(1);
});

test("dispatch-many — rejects non-array items with 400", async () => {
  const { broker } = makeBroker();
  const r = await rpc(broker, { op: "dispatch-many", items: "nope" });
  expect(r.status).toBe(400);
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

/**
 * Build a fake ctx variant with a Map-backed `storage.kv` facade, modeling
 * the SQLite-backed DO storage the broker persists subscription entries
 * into. The map outlives broker reconstruction in a test the way SQLite
 * storage outlives DO hibernation in workerd.
 */
function fakeCtxWithStorage() {
  const base = fakeCtx();
  const data = new Map<string, unknown>();
  return {
    ...base,
    data,
    storage: {
      kv: {
        get(key: string): unknown {
          return data.get(key);
        },
        put(key: string, value: unknown): void {
          data.set(key, value);
        },
        delete(key: string): void {
          data.delete(key);
        },
      },
    },
  };
}

test("hibernation rehydration — a woken DO rebuilds subs from storage", async () => {
  // Model a wake from hibernation: u1's subscription entries were persisted
  // into storage before the DO was evicted, and the fresh instance starts
  // with an empty in-memory map. The hibernating client never reconnects, so
  // no re-register RPC arrives; the DO must rebuild from storage alone.
  const ctx = fakeCtxWithStorage();
  ctx.data.set("subs:u1", [["project:p1", null]]);
  const ws = fakeSocket();
  ctx.acceptWebSocket(ws, ["u1"]);
  const broker = new MymirBroker(ctx as never, {
    BROKER_DO_SECRET: TEST_SECRET,
  } as never);

  const r = await rpc(broker, {
    op: "dispatch",
    key: "project:p1",
    payload: { kind: "project", projectId: "p1" },
  });

  expect(r.status).toBe(204);
  const frame = `data: ${JSON.stringify({ kind: "project", projectId: "p1" })}\n\n`;
  expect(ws.send).toHaveBeenCalledWith(frame);
});

test("register persists the user's sub set into storage", async () => {
  const ctx = fakeCtxWithStorage();
  ctx.acceptWebSocket(fakeSocket(), ["u1"]);
  const broker = new MymirBroker(ctx as never, {
    BROKER_DO_SECRET: TEST_SECRET,
  } as never);

  await rpc(broker, { op: "register", userId: "u1", key: "project:p1" });
  await rpc(broker, {
    op: "register",
    userId: "u1",
    key: "task:t1",
    ttlMs: 60_000,
  });

  const entries = ctx.data.get("subs:u1") as Array<[string, number | null]>;
  expect(entries.map((entry) => entry[0]).sort()).toEqual([
    "project:p1",
    "task:t1",
  ]);
});

test("register-many — one RPC registers every key for the user", async () => {
  const { ctx, broker } = makeBroker();
  const ws = attach(ctx, "u1");
  const r = await rpc(broker, {
    op: "register-many",
    userId: "u1",
    items: [{ key: "project:p1" }, { key: "project-list:u1" }],
  });
  expect(r.status).toBe(204);

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
  expect(ws.send).toHaveBeenCalledTimes(2);
});

test("register-many — rejects non-array items with 400", async () => {
  const { broker } = makeBroker();
  const r = await rpc(broker, {
    op: "register-many",
    userId: "u1",
    items: "nope",
  });
  expect(r.status).toBe(400);
});
