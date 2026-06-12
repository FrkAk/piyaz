import { test, expect, afterEach, spyOn } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { seedRichContextTask } from "@/tests/context/fixtures";
import { superuserPool } from "@/tests/setup/global";
import { GET } from "@/app/api/task/[taskId]/context/route";
import * as taskData from "@/lib/data/task";
import * as effectiveDeps from "@/lib/graph/effective-deps";
import * as projectData from "@/lib/data/project";
import { makeAuthContext } from "@/lib/auth/context";
import { buildAgentContext } from "@/lib/context/_core/agent";
import { buildPlanningContext } from "@/lib/context/_core/planning";
import { buildWorkingContext } from "@/lib/context/_core/working";
import type { BundlePart } from "@/lib/context/parts";

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
 * Fetch one bundle's sections for a seeded task as the given user.
 *
 * @param taskId - UUID of the task.
 * @param userId - Caller user id.
 * @param kind - Bundle kind query param (omit to test validation).
 * @returns The raw Response.
 */
async function getContext(
  taskId: string,
  userId: string,
  kind?: string,
): Promise<Response> {
  setSession({ user: { id: userId } });
  const qs = kind === undefined ? "" : `?bundle=${kind}`;
  return GET(new Request(`http://test/api/task/${taskId}/context${qs}`), {
    params: Promise.resolve({ taskId }),
  });
}

test("GET context — 401 when unauthenticated", async () => {
  setSession(null);
  const res = await GET(
    new Request(
      "http://test/api/task/00000000-0000-0000-0000-000000000000/context?bundle=agent",
    ),
    {
      params: Promise.resolve({
        taskId: "00000000-0000-0000-0000-000000000000",
      }),
    },
  );
  expect(res.status).toBe(401);
});

test("GET context — 400 on missing or unknown bundle kind", async () => {
  const f = await seedUserOrgProject("ctx-badkind");
  const taskId = await addTask(f.projectId, "ctx-badkind");
  expect((await getContext(taskId, f.userId)).status).toBe(400);
  expect((await getContext(taskId, f.userId, "execution")).status).toBe(400);
});

test("GET context — 404 for cross-team task access", async () => {
  const owner = await seedUserOrgProject("ctx-owner");
  const stranger = await seedUserOrgProject("ctx-stranger");
  const taskId = await addTask(owner.projectId, "ctx-cross");
  expect((await getContext(taskId, stranger.userId, "agent")).status).toBe(404);
});

test("GET context — 400 for record on a non-terminal task", async () => {
  const fx = await seedRichContextTask("ctx-record-nonterminal");
  expect((await getContext(fx.taskId, fx.userId, "record")).status).toBe(400);
});

test("GET context — record returns sections for a done task", async () => {
  const fx = await seedRichContextTask("ctx-record-done-route");
  const sql = superuserPool();
  try {
    await sql`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  const res = await getContext(fx.taskId, fx.userId, "record");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sections: BundlePart[] };
  expect(body.sections.map((s) => s.id)).toContain("execution");
});

test("GET context — per-kind section shape and joined-markdown parity", async () => {
  const fx = await seedRichContextTask("ctx-kinds");
  for (const kind of ["working", "planning", "agent", "review"] as const) {
    const res = await getContext(fx.taskId, fx.userId, kind);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sections: BundlePart[] };
    expect(body.sections.length).toBeGreaterThan(0);
    for (const s of body.sections) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.markdown).toBe("string");
    }
  }
  const agentRes = await getContext(fx.taskId, fx.userId, "agent");
  const agent = (await agentRes.json()) as { sections: BundlePart[] };
  const joined = agent.sections.map((s) => s.markdown).join("\n\n");
  expect(joined).toBe(
    await buildAgentContext(makeAuthContext(fx.userId), fx.taskId),
  );
});

test("GET context — 304 when If-None-Match matches", async () => {
  const f = await seedUserOrgProject("ctx-304");
  const taskId = await addTask(f.projectId, "ctx-304");
  const first = await getContext(taskId, f.userId, "working");
  expect(first.status).toBe(200);
  const etag = first.headers.get("ETag");
  expect(etag).toBeTruthy();
  setSession({ user: { id: f.userId } });
  const conditional = await GET(
    new Request(`http://test/api/task/${taskId}/context?bundle=working`, {
      headers: { "If-None-Match": etag! },
    }),
    { params: Promise.resolve({ taskId }) },
  );
  expect(conditional.status).toBe(304);
  expect(conditional.headers.get("ETag")).toBe(etag);
  expect(await conditional.text()).toBe("");
});

test("GET context — one task read and one traversal per agent request", async () => {
  const fx = await seedRichContextTask("ctx-counts");
  const fetchSpy = spyOn(taskData, "getTaskForDepthTx");
  const traversalSpy = spyOn(effectiveDeps, "loadBundleDeps");
  try {
    const res = await getContext(fx.taskId, fx.userId, "agent");
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(traversalSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
    traversalSpy.mockRestore();
  }
});

test("GET context — working kind issues no dependency traversal", async () => {
  const fx = await seedRichContextTask("ctx-working-lean");
  const traversalSpy = spyOn(effectiveDeps, "loadBundleDeps");
  try {
    const res = await getContext(fx.taskId, fx.userId, "working");
    expect(res.status).toBe(200);
    expect(traversalSpy).toHaveBeenCalledTimes(0);
  } finally {
    traversalSpy.mockRestore();
  }
});

test("GET context — validator path skips the full-task read", async () => {
  const fx = await seedRichContextTask("ctx-validator");
  const first = await getContext(fx.taskId, fx.userId, "agent");
  const etag = first.headers.get("ETag");
  expect(etag).toBeTruthy();
  const fetchSpy = spyOn(taskData, "getTaskForDepthTx");
  const traversalSpy = spyOn(effectiveDeps, "loadBundleDeps");
  try {
    setSession({ user: { id: fx.userId } });
    const conditional = await GET(
      new Request(`http://test/api/task/${fx.taskId}/context?bundle=agent`, {
        headers: { "If-None-Match": etag! },
      }),
      { params: Promise.resolve({ taskId: fx.taskId }) },
    );
    expect(conditional.status).toBe(304);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(traversalSpy).toHaveBeenCalledTimes(0);
  } finally {
    fetchSpy.mockRestore();
    traversalSpy.mockRestore();
  }
});

test("MCP buildWorkingContext fetches per depth: no dependency closure", async () => {
  const fx = await seedRichContextTask("ctx-mcp-working");
  const ctx = makeAuthContext(fx.userId);

  const fetchSpy = spyOn(taskData, "getTaskForDepthTx");
  const traversalSpy = spyOn(effectiveDeps, "loadBundleDeps");
  const projectSpy = spyOn(projectData, "getProjectHeader");

  try {
    await buildWorkingContext(ctx, fx.taskId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(traversalSpy).toHaveBeenCalledTimes(0);
    expect(projectSpy).toHaveBeenCalledTimes(0);
  } finally {
    fetchSpy.mockRestore();
    traversalSpy.mockRestore();
    projectSpy.mockRestore();
  }
});

test("MCP buildAgentContext fetches per depth: closure but no project header", async () => {
  const fx = await seedRichContextTask("ctx-mcp-agent");
  const ctx = makeAuthContext(fx.userId);

  const fetchSpy = spyOn(taskData, "getTaskForDepthTx");
  const traversalSpy = spyOn(effectiveDeps, "loadBundleDeps");
  const projectSpy = spyOn(projectData, "getProjectHeader");

  try {
    await buildAgentContext(ctx, fx.taskId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(traversalSpy).toHaveBeenCalledTimes(1);
    expect(projectSpy).toHaveBeenCalledTimes(0);
  } finally {
    fetchSpy.mockRestore();
    traversalSpy.mockRestore();
    projectSpy.mockRestore();
  }
});

test("MCP buildPlanningContext fetches per depth: closure plus project header", async () => {
  const fx = await seedRichContextTask("ctx-mcp-planning");
  const ctx = makeAuthContext(fx.userId);

  const fetchSpy = spyOn(taskData, "getTaskForDepthTx");
  const traversalSpy = spyOn(effectiveDeps, "loadBundleDeps");
  const projectSpy = spyOn(projectData, "getProjectHeader");

  try {
    await buildPlanningContext(ctx, fx.taskId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(traversalSpy).toHaveBeenCalledTimes(1);
    expect(projectSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
    traversalSpy.mockRestore();
    projectSpy.mockRestore();
  }
});

test("MCP agent depth delegates to the record bundle for done tasks", async () => {
  const fx = await seedRichContextTask("ctx-mcp-record-done");
  const sql = superuserPool();
  try {
    await sql`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  const result = await buildAgentContext(makeAuthContext(fx.userId), fx.taskId);
  expect(result).toContain("## How It Completed");
  expect(result).toContain("## Project Context");
  expect(result).not.toContain("## Implementation Plan");
  expect(result).not.toContain("## Done Means");
});

test("MCP agent depth delegates to the record bundle for cancelled tasks", async () => {
  const fx = await seedRichContextTask("ctx-mcp-record-cancelled");
  const sql = superuserPool();
  try {
    await sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${fx.taskId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  const result = await buildAgentContext(makeAuthContext(fx.userId), fx.taskId);
  expect(result).toContain("## Why It Was Cancelled");
});

test("MCP agent-to-record delegation fetches once at record depth", async () => {
  const fx = await seedRichContextTask("ctx-mcp-record-counts");
  const sql = superuserPool();
  try {
    await sql`UPDATE tasks SET status = 'done' WHERE id = ${fx.taskId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  const fetchSpy = spyOn(taskData, "getTaskForDepthTx");
  const projectSpy = spyOn(projectData, "getProjectHeader");
  try {
    await buildAgentContext(makeAuthContext(fx.userId), fx.taskId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][2]).toBe("record");
    expect(projectSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
    projectSpy.mockRestore();
  }
});
