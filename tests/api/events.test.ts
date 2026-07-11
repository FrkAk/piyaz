import { test, expect, afterEach, spyOn } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { broker, MAX_CONNECTIONS_PER_USER } from "@/lib/realtime/broker";
import { GET } from "@/app/api/events/route";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  broker._resetForTests();
  await truncateAll();
});

/**
 * Read one byte off a ReadableStream so the upstream `start(controller)`
 * has a chance to run and complete its `attach`/`register` block. Returns
 * the decoded payload of the first chunk so the caller can also assert on
 * the initial `: hello` comment frame.
 */
async function pumpFirstFrame(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value);
}

test("GET /api/events — 401 when unauthenticated", async () => {
  const res = await GET(new Request("http://test/api/events"));
  expect(res.status).toBe(401);
});

test("GET /api/events — 429 when caller is at the per-user connection cap", async () => {
  const f = await seedUserOrgProject("sse-cap");
  setSession({ user: { id: f.userId } });

  // Saturate the broker for this user before opening the route.
  for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
    broker.attach(f.userId, { send() {}, close() {} });
  }

  const res = await GET(new Request("http://test/api/events"));
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("5");
});

test("GET /api/events — attaches connection and registers project subs in start(), then cleans up on abort", async () => {
  const f = await seedUserOrgProject("sse-attach");
  setSession({ user: { id: f.userId } });

  const ac = new AbortController();
  const res = await GET(
    new Request("http://test/api/events", { signal: ac.signal }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");

  // Pump the first chunk so `start(controller)` runs and its attach/
  // register block executes.
  const stream = res.body as ReadableStream<Uint8Array>;
  const firstFrame = await pumpFirstFrame(stream);
  expect(firstFrame).toContain(": hello");

  // The route's invariant: by the time `start` returns, the broker
  // sees BOTH a live connection AND a registered project sub. If
  // attach were to run AFTER register, dispatches racing with the
  // start would yield a subscriber-without-connection and silently
  // drop the event.
  expect(broker.hasConnections(f.userId)).toBe(true);
  expect([...broker.subscribers(`project:${f.projectId}`)]).toEqual([f.userId]);
  expect([...broker.subscribers(`project-list:${f.userId}`)]).toEqual([
    f.userId,
  ]);

  // Aborting the request fires the route's `signal.addEventListener('abort', ...)`
  // which detaches the connection and (since this is the last conn for
  // the user) clears every sub for the user.
  ac.abort();
  // Yield once so the abort handler can run.
  await new Promise((r) => setTimeout(r, 0));

  expect(broker.hasConnections(f.userId)).toBe(false);
  expect([...broker.subscribers(`project:${f.projectId}`)]).toEqual([]);
  expect([...broker.subscribers(`project-list:${f.userId}`)]).toEqual([]);
});

test("GET /api/events — dispatches reach the new connection (sanity check on attach-before-register)", async () => {
  const f = await seedUserOrgProject("sse-dispatch");
  setSession({ user: { id: f.userId } });

  const ac = new AbortController();
  const res = await GET(
    new Request("http://test/api/events", { signal: ac.signal }),
  );
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();

  // Drain the initial `: hello` so the next read lands on the dispatch.
  await reader.read();

  broker.dispatch(`project:${f.projectId}`, {
    kind: "project",
    projectId: f.projectId,
  });

  const { value } = await reader.read();
  const frame = dec.decode(value);
  expect(frame).toContain(`"kind":"project"`);
  expect(frame).toContain(`"projectId":"${f.projectId}"`);

  reader.releaseLock();
  ac.abort();
  await new Promise((r) => setTimeout(r, 0));
});

test("GET /api/events — concurrent attaches respect the cap atomically (closes the TOCTOU race)", async () => {
  // Regression guard for the authoritative inner gate: the outer
  // `isAtConnectionLimit` check is a racy fast-path (N concurrent requests
  // can all read `current < cap` before any attaches), so the `tryAttach`
  // inside `start(controller)` is the real cap. Stub the fast-path to always
  // pass so BOTH requests deterministically contend at `tryAttach`,
  // independent of how the async prelude interleaves; the (cap+1)-th attach
  // must lose and close, leaving the broker at exactly cap.
  const f = await seedUserOrgProject("sse-toctou");
  setSession({ user: { id: f.userId } });

  // Saturate (cap-1) so exactly one slot remains for the two requests.
  for (let i = 0; i < MAX_CONNECTIONS_PER_USER - 1; i++) {
    broker.attach(f.userId, { send() {}, close() {} });
  }

  const limitSpy = spyOn(broker, "isAtConnectionLimit").mockReturnValue(false);
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  try {
    const [r1, r2] = await Promise.all([
      GET(new Request("http://test/api/events", { signal: ac1.signal })),
      GET(new Request("http://test/api/events", { signal: ac2.signal })),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Pump both streams so each `start(controller)` runs its `tryAttach`.
    await pumpFirstFrame(r1.body as ReadableStream<Uint8Array>);
    await pumpFirstFrame(r2.body as ReadableStream<Uint8Array>);

    // Both cleared the (bypassed) outer check, but `tryAttach` admits only
    // one: the broker must hold exactly cap, never cap+1.
    const set = (
      broker as unknown as {
        conns: Map<string, Set<unknown>>;
      }
    ).conns.get(f.userId);
    expect(set?.size).toBe(MAX_CONNECTIONS_PER_USER);
  } finally {
    limitSpy.mockRestore();
    ac1.abort();
    ac2.abort();
    await new Promise((r) => setTimeout(r, 0));
  }
});
