import { test, expect, afterEach } from "bun:test";
import postgres from "postgres";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { getConnectionString } from "@/tests/setup/container";
import {
  getProjectSlim,
  getProjectFull,
  listProjectsSlim,
} from "@/lib/data/project";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

test("getProjectSlim returns only the slim shape", async () => {
  const f = await seedUserOrgProject("slim");
  const ctx = makeAuthContext(f.userId);

  const p = await getProjectSlim(ctx, f.projectId);

  expect(Object.keys(p).sort()).toEqual([
    "id",
    "identifier",
    "organizationId",
    "status",
    "title",
    "updatedAt",
  ]);
  expect(p.id).toBe(f.projectId);
  expect(p.organizationId).toBe(f.organizationId);
});

test("getProjectFull returns project + tasks + edges + organization", async () => {
  const f = await seedUserOrgProject("full");
  const ctx = makeAuthContext(f.userId);

  const p = await getProjectFull(ctx, f.projectId);

  expect(p.id).toBe(f.projectId);
  expect(p.organization.id).toBe(f.organizationId);
  expect(Array.isArray(p.tasks)).toBe(true);
  expect(Array.isArray(p.edges)).toBe(true);
  expect(p.memberRole).toBe("owner");
});

test("listProjectsSlim paginates with cursor", async () => {
  const f = await seedUserOrgProject("page");
  const ctx = makeAuthContext(f.userId);

  const sqlc = postgres(getConnectionString(), { max: 1 });
  try {
    for (let i = 0; i < 5; i++) {
      await sqlc`
        INSERT INTO projects ("organization_id", "title", "identifier", "updated_at")
        VALUES (${f.organizationId}, ${"P" + i}, ${"PRJ" + i}, ${new Date(Date.now() + (i + 1) * 1000)})
      `;
    }
  } finally {
    await sqlc.end({ timeout: 5 });
  }

  const page1 = await listProjectsSlim(ctx, { limit: 3 });
  expect(page1.rows.length).toBe(3);
  expect(page1.nextCursor).not.toBeNull();

  const page2 = await listProjectsSlim(ctx, {
    limit: 3,
    cursor: page1.nextCursor,
  });
  expect(page2.rows.length).toBe(3);
  expect(page2.nextCursor).toBeNull();

  const page1Ids = new Set(page1.rows.map((r) => r.id));
  const page2Ids = new Set(page2.rows.map((r) => r.id));
  for (const id of page2Ids) expect(page1Ids.has(id)).toBe(false);

  expect(page1Ids.size + page2Ids.size).toBe(6);
});

test("listProjectsSlim caps limit at 100", async () => {
  const f = await seedUserOrgProject("cap");
  const ctx = makeAuthContext(f.userId);
  const page = await listProjectsSlim(ctx, { limit: 500 });
  expect(page.rows.length).toBeLessThanOrEqual(100);
});
