import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import {
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { buildWorkingContext } from "@/lib/context/_core/working";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

describe("buildWorkingContext under app_user", () => {
  test("returns ancestor project and sibling tasks for an authorized caller", async () => {
    const fx = await seedUserOrgProject("working-ctx-1");
    const sr = serviceRoleConnect();
    let mainTaskId: string;
    try {
      const [main] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fx.projectId}, 'Main', 1)
        RETURNING id`;
      await sr`INSERT INTO tasks (project_id, title, sequence_number)
               VALUES (${fx.projectId}, 'Sibling', 2)`;
      mainTaskId = main.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildWorkingContext(ctx, mainTaskId);
    expect(result.ancestors.length).toBe(1);
    expect(result.ancestors[0].id).toBe(fx.projectId);
    expect(result.siblings.length).toBe(1);
    expect(result.siblings[0].title).toBe("Sibling");
  });

  test("rejects cross-team callers (RLS isolation under app_user)", async () => {
    const fxA = await seedUserOrgProject("working-ctx-a");
    const fxB = await seedUserOrgProject("working-ctx-b");
    const sr = serviceRoleConnect();
    let taskInAId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number)
        VALUES (${fxA.projectId}, 'In team A', 1)
        RETURNING id`;
      taskInAId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fxB.userId);
    await expect(buildWorkingContext(ctx, taskInAId)).rejects.toThrow(
      ForbiddenError,
    );
  });
});
