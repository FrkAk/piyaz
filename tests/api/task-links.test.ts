import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { broker } from "@/lib/realtime/broker";
import { GET } from "@/app/api/task/[taskId]/route";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask, updateTask, addTaskLink } from "@/lib/data/task";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  broker._resetForTests();
  await truncateAll();
});

test("GET /api/task/[id] returns links in the response body for the owner", async () => {
  const f = await seedUserOrgProject("api-links-owner");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await updateTask(ctx, task.id, { prUrl: "https://github.com/o/r/pull/1" });
  await addTaskLink(ctx, task.id, "https://github.com/o/r/issues/2");

  setSession({ user: { id: f.userId } });
  const res = await GET(new Request(`http://test/api/task/${task.id}`), {
    params: Promise.resolve({ taskId: task.id }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    links: Array<{ kind: string; url: string }>;
  };
  expect(Array.isArray(body.links)).toBe(true);
  const kinds = body.links.map((l) => l.kind).sort();
  expect(kinds).toEqual(["issue", "pull_request"]);
});

test("GET /api/task/[id] returns 404 for a cross-team caller (no links leak in body)", async () => {
  const owner = await seedUserOrgProject("api-links-x1");
  const stranger = await seedUserOrgProject("api-links-x2");
  const ownerCtx = makeAuthContext(owner.userId);
  const task = await createTask(ownerCtx, {
    projectId: owner.projectId,
    title: "T",
  });
  await updateTask(ownerCtx, task.id, {
    prUrl: "https://github.com/o/r/pull/secret",
  });

  setSession({ user: { id: stranger.userId } });
  const res = await GET(new Request(`http://test/api/task/${task.id}`), {
    params: Promise.resolve({ taskId: task.id }),
  });
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).not.toContain("pull/secret");
});

test("GET /api/task/[id] returns 401 without a session", async () => {
  const f = await seedUserOrgProject("api-links-noauth");
  const ctx = makeAuthContext(f.userId);
  const task = await createTask(ctx, { projectId: f.projectId, title: "T" });
  await updateTask(ctx, task.id, { prUrl: "https://github.com/o/r/pull/3" });

  setSession(null);
  const res = await GET(new Request(`http://test/api/task/${task.id}`), {
    params: Promise.resolve({ taskId: task.id }),
  });
  expect(res.status).toBe(401);
});

test("GET /api/task/[id] returns 404 for a non-existent taskId (no enumeration)", async () => {
  const f = await seedUserOrgProject("api-links-missing");
  setSession({ user: { id: f.userId } });

  const res = await GET(
    new Request("http://test/api/task/00000000-0000-0000-0000-000000000000"),
    {
      params: Promise.resolve({
        taskId: "00000000-0000-0000-0000-000000000000",
      }),
    },
  );
  expect(res.status).toBe(404);
});

test("GET /api/task/[id] scopes the links array to the requested task only", async () => {
  const f = await seedUserOrgProject("api-links-scope");
  const ctx = makeAuthContext(f.userId);
  const a = await createTask(ctx, { projectId: f.projectId, title: "A" });
  const b = await createTask(ctx, { projectId: f.projectId, title: "B" });
  await updateTask(ctx, a.id, { prUrl: "https://github.com/o/r/pull/100" });
  await updateTask(ctx, b.id, { prUrl: "https://github.com/o/r/pull/200" });

  setSession({ user: { id: f.userId } });
  const res = await GET(new Request(`http://test/api/task/${a.id}`), {
    params: Promise.resolve({ taskId: a.id }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    links: Array<{ url: string }>;
  };
  expect(body.links.length).toBe(1);
  expect(body.links[0].url).toContain("pull/100");
  expect(body.links[0].url).not.toContain("pull/200");
});
