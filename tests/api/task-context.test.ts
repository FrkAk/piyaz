import { test, expect, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { getConnectionString } from "@/tests/setup/global";
import { GET } from "@/app/api/task/[taskId]/context/route";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  await truncateAll();
});

/** Insert a task into a seeded project; return its id. */
async function addTask(projectId: string, suffix: string): Promise<string> {
  const sql = postgres(getConnectionString(), { max: 1 });
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

test("GET /api/task/[id]/context — 401 when unauthenticated", async () => {
  const res = await GET(
    new Request(
      "http://test/api/task/00000000-0000-0000-0000-000000000000/context",
    ),
    {
      params: Promise.resolve({
        taskId: "00000000-0000-0000-0000-000000000000",
      }),
    },
  );
  expect(res.status).toBe(401);
});

test("GET /api/task/[id]/context — 404 for cross-team task access", async () => {
  const owner = await seedUserOrgProject("ctx-owner");
  const stranger = await seedUserOrgProject("ctx-stranger");
  const taskId = await addTask(owner.projectId, "ctx-cross");

  setSession({ user: { id: stranger.userId } });
  const res = await GET(
    new Request(`http://test/api/task/${taskId}/context`),
    { params: Promise.resolve({ taskId }) },
  );
  expect(res.status).toBe(404);
});

test("GET /api/task/[id]/context — 200 with body and ETag for the owner", async () => {
  const f = await seedUserOrgProject("ctx-200");
  const taskId = await addTask(f.projectId, "ctx-ok");

  setSession({ user: { id: f.userId } });
  const res = await GET(
    new Request(`http://test/api/task/${taskId}/context`),
    { params: Promise.resolve({ taskId }) },
  );

  expect(res.status).toBe(200);
  expect(res.headers.get("ETag")).toMatch(/^"\d+"$/);
  const body = (await res.json()) as {
    agent: string;
    planning: string;
    working: string;
  };
  expect(typeof body.agent).toBe("string");
  expect(typeof body.planning).toBe("string");
  expect(typeof body.working).toBe("string");
});

test("GET /api/task/[id]/context — 304 when If-None-Match matches", async () => {
  const f = await seedUserOrgProject("ctx-304");
  const taskId = await addTask(f.projectId, "ctx-304");

  setSession({ user: { id: f.userId } });

  const first = await GET(
    new Request(`http://test/api/task/${taskId}/context`),
    { params: Promise.resolve({ taskId }) },
  );
  expect(first.status).toBe(200);
  const etag = first.headers.get("ETag");
  expect(etag).toBeTruthy();

  const conditional = await GET(
    new Request(`http://test/api/task/${taskId}/context`, {
      headers: { "If-None-Match": etag! },
    }),
    { params: Promise.resolve({ taskId }) },
  );
  expect(conditional.status).toBe(304);
  expect(conditional.headers.get("ETag")).toBe(etag);
  expect(await conditional.text()).toBe("");
});
