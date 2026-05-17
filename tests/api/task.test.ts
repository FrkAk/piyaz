import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
import { broker } from "@/lib/realtime/broker";
import { GET } from "@/app/api/task/[taskId]/route";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  broker._resetForTests();
  await truncateAll();
});

/** Insert a task into a seeded project; return its id. */
async function addTask(projectId: string, suffix: string): Promise<string> {
  const sql = superuserPool();
  try {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number")
      VALUES (${projectId}, ${"Task " + suffix}, 1)
      RETURNING id
    `;
    return t.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test("GET /api/task/[id] — does NOT register a broker sub when the user has no live connection", async () => {
  // Regression guard: registering a `task:<id>` sub for a connection-less
  // caller leaks the entry into `subs[userId]` until the 10-min TTL elapses.
  // Authenticated-but-never-connected callers (MCP tokens, programmatic
  // probes) would otherwise grow the broker's memory footprint without bound.
  const f = await seedUserOrgProject("task-noconn");
  const taskId = await addTask(f.projectId, "noconn");

  setSession({ user: { id: f.userId } });
  expect(broker.hasConnections(f.userId)).toBe(false);

  const res = await GET(new Request(`http://test/api/task/${taskId}`), {
    params: Promise.resolve({ taskId }),
  });
  expect(res.status).toBe(200);

  expect([...broker.subscribers(`task:${taskId}`)]).toEqual([]);
});

test("GET /api/task/[id] — registers a 10-min TTL sub when the user has a live connection", async () => {
  const f = await seedUserOrgProject("task-conn");
  const taskId = await addTask(f.projectId, "conn");

  setSession({ user: { id: f.userId } });
  broker.attach(f.userId, { send() {}, close() {} });
  expect(broker.hasConnections(f.userId)).toBe(true);

  const res = await GET(new Request(`http://test/api/task/${taskId}`), {
    params: Promise.resolve({ taskId }),
  });
  expect(res.status).toBe(200);

  expect([...broker.subscribers(`task:${taskId}`)]).toEqual([f.userId]);
});
