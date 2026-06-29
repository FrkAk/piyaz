import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { superuserPool } from "@/tests/setup/global";
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

test("GET /api/projects — 200 with paged body and ETag for an authenticated caller", async () => {
  const f = await seedUserOrgProject("projlist-200");
  setSession({ user: { id: f.userId } });

  const res = await GET(new Request("http://test/api/projects"));

  expect(res.status).toBe(200);
  expect(res.headers.get("ETag")).toMatch(/^"\d+"$/);
  const body = (await res.json()) as {
    rows: Array<{ id: string }>;
    nextCursor: string | null;
  };
  expect(body.rows.some((p) => p.id === f.projectId)).toBe(true);
  expect(body.nextCursor).toBeNull();
});

test("GET /api/projects — list entry has no categories or createdAt keys", async () => {
  const f = await seedUserOrgProject("projlist-keys");
  setSession({ user: { id: f.userId } });

  const res = await GET(new Request("http://test/api/projects"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    rows: Array<Record<string, unknown>>;
  };
  const entry = body.rows.find((p) => p.id === f.projectId);
  expect(entry).toBeDefined();
  expect(Object.keys(entry!)).not.toContain("categories");
  expect(Object.keys(entry!)).not.toContain("createdAt");
});

test("GET /api/projects — cursor paginates through the list", async () => {
  const f = await seedUserOrgProject("projlist-page");
  setSession({ user: { id: f.userId } });

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO projects ("organization_id", "title", "identifier", "updated_at")
      VALUES
        (${f.organizationId}, 'Second', 'SECOND', ${new Date(Date.now() + 1000)})
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const first = (await (
    await GET(new Request("http://test/api/projects?limit=1"))
  ).json()) as { rows: Array<{ id: string }>; nextCursor: string | null };
  expect(first.rows).toHaveLength(1);
  expect(first.nextCursor).toBeTruthy();

  const second = (await (
    await GET(
      new Request(
        `http://test/api/projects?limit=1&cursor=${encodeURIComponent(
          first.nextCursor!,
        )}`,
      ),
    )
  ).json()) as { rows: Array<{ id: string }>; nextCursor: string | null };
  expect(second.rows).toHaveLength(1);
  expect(second.rows[0].id).not.toBe(first.rows[0].id);
});

test("GET /api/projects — a malformed cursor falls back to the first page, not a 500", async () => {
  const f = await seedUserOrgProject("projlist-badcursor");
  setSession({ user: { id: f.userId } });

  const crafted = Buffer.from(
    JSON.stringify({ u: "not-a-date", i: "x" }),
    "utf8",
  ).toString("base64url");
  const res = await GET(
    new Request(
      `http://test/api/projects?cursor=${encodeURIComponent(crafted)}`,
    ),
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: Array<{ id: string }> };
  expect(body.rows.some((p) => p.id === f.projectId)).toBe(true);
});

test("GET /api/projects — an empty ?limit= falls back to the default page, not a 1-row page", async () => {
  const f = await seedUserOrgProject("projlist-emptylimit");
  setSession({ user: { id: f.userId } });

  const sqlc = superuserPool();
  try {
    await sqlc`
      INSERT INTO projects ("organization_id", "title", "identifier", "updated_at")
      VALUES
        (${f.organizationId}, 'Second', 'SECOND2', ${new Date(Date.now() + 1000)})
    `;
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const res = await GET(new Request("http://test/api/projects?limit="));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: Array<{ id: string }> };
  expect(body.rows).toHaveLength(2);
});

test("GET /api/projects — a fractional ?limit= does not reach the DB as a 500", async () => {
  const f = await seedUserOrgProject("projlist-fraclimit");
  setSession({ user: { id: f.userId } });

  const res = await GET(new Request("http://test/api/projects?limit=1.5"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: Array<{ id: string }> };
  expect(body.rows.some((p) => p.id === f.projectId)).toBe(true);
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
