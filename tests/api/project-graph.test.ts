import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { broker } from "@/lib/realtime/broker";
import { GET } from "@/app/api/project/[projectId]/graph/route";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { applyTaskEdit } from "@/lib/data/task-edit";

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
 * Invoke the graph route GET handler directly.
 *
 * @param projectId - Project UUID for the route param.
 * @param headers - Request headers.
 * @returns The handler response.
 */
function call(
  projectId: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return GET(
    new Request(`http://test/api/project/${projectId}/graph`, { headers }),
    { params: Promise.resolve({ projectId }) },
  );
}

test("heavy-only task writes answer 304 on the cached graph ETag; slim writes answer 200", async () => {
  const fx = await seedUserOrgProject("graph-meta-304");
  const ctx = makeAuthContext(fx.userId);
  const task = await createTask(ctx, { projectId: fx.projectId, title: "T" });
  setSession({ user: { id: fx.userId } });

  const first = await call(fx.projectId);
  expect(first.status).toBe(200);
  const etag = first.headers.get("etag");
  expect(etag).not.toBeNull();

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "implementationPlan", value: "plan body" },
    { op: "add", collection: "decisions", text: "Chose X. Cheaper than Y." },
  ]);
  const afterHeavy = await call(fx.projectId, {
    "if-none-match": etag as string,
  });
  expect(afterHeavy.status).toBe(304);
  expect(await afterHeavy.text()).toBe("");

  await applyTaskEdit(ctx, task.id, [
    { op: "set", field: "status", value: "planned" },
  ]);
  const afterSlim = await call(fx.projectId, {
    "if-none-match": etag as string,
  });
  expect(afterSlim.status).toBe(200);
  expect(afterSlim.headers.get("etag")).not.toBe(etag);
  const body = (await afterSlim.json()) as {
    tasks: Array<{ id: string; status: string }>;
  };
  expect(body.tasks.find((t) => t.id === task.id)?.status).toBe("planned");
});

test("an unauthenticated graph request is rejected before any validator work", async () => {
  const fx = await seedUserOrgProject("graph-meta-auth");
  setSession(null);
  const res = await call(fx.projectId);
  expect(res.status).toBe(401);
});
