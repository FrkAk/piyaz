import { test, expect, afterEach, spyOn } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import {
  seedRichContextTask,
  normalizeContextGolden,
} from "@/tests/context/fixtures";
import { superuserPool } from "@/tests/setup/global";
import { GET } from "@/app/api/task/[taskId]/context/route";
import * as rls from "@/lib/db/rls";
import { makeAuthContext } from "@/lib/auth/context";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { buildPlanningContext } from "@/lib/context/_core/planning";
import { buildWorkingContext } from "@/lib/context/_core/working";

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

/**
 * Fetch the `{ agent, planning, working }` payload for a seeded task as the
 * given owner.
 *
 * @param taskId - UUID of the task.
 * @param userId - Owner user id.
 * @returns The parsed bundle payload.
 */
async function fetchBundle(
  taskId: string,
  userId: string,
): Promise<{ agent: string; planning: string; working: string }> {
  setSession({ user: { id: userId } });
  const res = await GET(new Request(`http://test/api/task/${taskId}/context`), {
    params: Promise.resolve({ taskId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    agent: string;
    planning: string;
    working: string;
  };
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
  const res = await GET(new Request(`http://test/api/task/${taskId}/context`), {
    params: Promise.resolve({ taskId }),
  });
  expect(res.status).toBe(404);
});

test("GET /api/task/[id]/context — 200 with body and ETag for the owner", async () => {
  const f = await seedUserOrgProject("ctx-200");
  const taskId = await addTask(f.projectId, "ctx-ok");

  setSession({ user: { id: f.userId } });
  const res = await GET(new Request(`http://test/api/task/${taskId}/context`), {
    params: Promise.resolve({ taskId }),
  });

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

test("GET /api/task/[id]/context — golden bundle for a fully-populated task", async () => {
  const fx = await seedRichContextTask("ctx-golden");
  const body = await fetchBundle(fx.taskId, fx.userId);

  expect({
    agent: normalizeContextGolden(body.agent, "ctx-golden"),
    planning: normalizeContextGolden(body.planning, "ctx-golden"),
    working: normalizeContextGolden(body.working, "ctx-golden"),
  }).toMatchSnapshot();
});

test("GET /api/task/[id]/context — two read batches resolve the bundle", async () => {
  const fx = await seedRichContextTask("ctx-counts");

  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    await fetchBundle(fx.taskId, fx.userId);
    expect(readSpy).toHaveBeenCalledTimes(2);
  } finally {
    readSpy.mockRestore();
  }
});

test("GET /api/task/[id]/context — validator path issues no read batches", async () => {
  const fx = await seedRichContextTask("ctx-validator");

  setSession({ user: { id: fx.userId } });
  const first = await GET(
    new Request(`http://test/api/task/${fx.taskId}/context`),
    { params: Promise.resolve({ taskId: fx.taskId }) },
  );
  const etag = first.headers.get("ETag");
  expect(etag).toBeTruthy();

  const readSpy = spyOn(rls, "withUserContextRead");

  try {
    const conditional = await GET(
      new Request(`http://test/api/task/${fx.taskId}/context`, {
        headers: { "If-None-Match": etag! },
      }),
      { params: Promise.resolve({ taskId: fx.taskId }) },
    );
    expect(conditional.status).toBe(304);
    expect(readSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
  }
});

test("MCP buildWorkingContext resolves without the dependency closure", async () => {
  const fx = await seedRichContextTask("ctx-mcp-working");
  const ctx = makeAuthContext(fx.userId);

  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    await buildWorkingContext(ctx, fx.taskId);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});

test("MCP buildAgentContext resolves in two read batches", async () => {
  const fx = await seedRichContextTask("ctx-mcp-agent");
  const ctx = makeAuthContext(fx.userId);

  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    await buildAgentContext(ctx, fx.taskId);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});

test("MCP buildPlanningContext resolves in two read batches", async () => {
  const fx = await seedRichContextTask("ctx-mcp-planning");
  const ctx = makeAuthContext(fx.userId);

  const readSpy = spyOn(rls, "withUserContextRead");
  const interactiveSpy = spyOn(rls, "withUserContext");

  try {
    await buildPlanningContext(ctx, fx.taskId);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(interactiveSpy).toHaveBeenCalledTimes(0);
  } finally {
    readSpy.mockRestore();
    interactiveSpy.mockRestore();
  }
});
