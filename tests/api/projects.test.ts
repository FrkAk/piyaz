import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { GET } from "@/app/api/projects/route";

const setSession = (
  globalThis as unknown as {
    __setTestSession: (s: { user: { id: string } } | null) => void;
  }
).__setTestSession;

afterEach(async () => {
  await truncateAll();
});

test("GET /api/projects — 401 when unauthenticated", async () => {
  const res = await GET(new Request("http://test/api/projects"));
  expect(res.status).toBe(401);
});

test("GET /api/projects — 200 with body and ETag for an authenticated caller", async () => {
  const f = await seedUserOrgProject("projlist-200");
  setSession({ user: { id: f.userId } });

  const res = await GET(new Request("http://test/api/projects"));

  expect(res.status).toBe(200);
  expect(res.headers.get("ETag")).toMatch(/^"\d+"$/);
  const body = (await res.json()) as Array<{ id: string }>;
  expect(body.some((p) => p.id === f.projectId)).toBe(true);
});

test("GET /api/projects — 304 when If-None-Match matches the current ETag", async () => {
  const f = await seedUserOrgProject("projlist-304");
  setSession({ user: { id: f.userId } });

  const first = await GET(new Request("http://test/api/projects"));
  expect(first.status).toBe(200);
  const etag = first.headers.get("ETag");
  expect(etag).toBeTruthy();

  const conditional = await GET(
    new Request("http://test/api/projects", {
      headers: { "If-None-Match": etag! },
    }),
  );
  expect(conditional.status).toBe(304);
  expect(conditional.headers.get("ETag")).toBe(etag);
  expect(await conditional.text()).toBe("");
});
