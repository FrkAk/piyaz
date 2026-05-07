import { test, expect, afterEach } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import {
  assertProjectAccess,
  ForbiddenError,
} from "@/lib/auth/authorization";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

test("assertProjectAccess returns row + role for in-team caller", async () => {
  const f = await seedUserOrgProject("a");
  const ctx = makeAuthContext(f.userId);

  const access = await assertProjectAccess(f.projectId, ctx);

  expect(access.project.id).toBe(f.projectId);
  expect(access.project.organizationId).toBe(f.organizationId);
  expect(access.memberRole).toBe("owner");
});

test("assertProjectAccess raises ForbiddenError on cross-team probe", async () => {
  const owner = await seedUserOrgProject("b1");
  const stranger = await seedUserOrgProject("b2");
  const ctx = makeAuthContext(stranger.userId);

  let caught: unknown;
  try {
    await assertProjectAccess(owner.projectId, ctx);
  } catch (e) {
    caught = e;
  }

  expect(caught).toBeInstanceOf(ForbiddenError);
  if (caught instanceof ForbiddenError) {
    expect(caught.resource).toBe("project");
    expect(caught.resourceId).toBe(owner.projectId);
  }
});

test("assertProjectAccess raises ForbiddenError when project does not exist", async () => {
  const f = await seedUserOrgProject("c");
  const ctx = makeAuthContext(f.userId);

  let caught: unknown;
  try {
    await assertProjectAccess(
      "00000000-0000-0000-0000-000000000000",
      ctx,
    );
  } catch (e) {
    caught = e;
  }

  expect(caught).toBeInstanceOf(ForbiddenError);
});

test("assertProjectAccess rejects malformed UUIDs without DB hit", async () => {
  const f = await seedUserOrgProject("d");
  const ctx = makeAuthContext(f.userId);

  await expect(
    assertProjectAccess("not-a-uuid", ctx),
  ).rejects.toThrow(ForbiddenError);
});
