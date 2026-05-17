import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import {
  seedUserOrgProject,
  serviceRoleConnect,
} from "@/tests/setup/seed";
import { buildReviewContext } from "@/lib/context/_core/review";
import { makeAuthContext } from "@/lib/auth/context";
import { ForbiddenError } from "@/lib/auth/authorization";

afterEach(async () => {
  await truncateAll();
});

describe("buildReviewContext under app_user", () => {
  test("returns populated in-review context for an authorized caller", async () => {
    const fx = await seedUserOrgProject("review-ctx-1");
    const sr = serviceRoleConnect();
    let taskId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, status,
          implementation_plan, execution_record)
        VALUES (${fx.projectId}, 'Done task', 1, 'in_review',
          'plan body', 'execution body')
        RETURNING id`;
      await sr`INSERT INTO task_acceptance_criteria (id, task_id, text, checked, position)
               VALUES (gen_random_uuid(), ${t.id}, 'ac', true, 0)`;
      taskId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fx.userId);
    const result = await buildReviewContext(ctx, taskId);
    expect(result).not.toBeNull();
    expect(result).toContain("plan body");
    expect(result).toContain("execution body");
  });

  test("rejects cross-team callers (RLS isolation under app_user)", async () => {
    const fxA = await seedUserOrgProject("review-ctx-a");
    const fxB = await seedUserOrgProject("review-ctx-b");
    const sr = serviceRoleConnect();
    let taskInAId: string;
    try {
      const [t] = await sr<{ id: string }[]>`
        INSERT INTO tasks (project_id, title, sequence_number, status,
          implementation_plan, execution_record)
        VALUES (${fxA.projectId}, 'In review', 1, 'in_review', 'p', 'e')
        RETURNING id`;
      taskInAId = t.id;
    } finally {
      await sr.end({ timeout: 5 });
    }

    const ctx = makeAuthContext(fxB.userId);
    await expect(buildReviewContext(ctx, taskInAId)).rejects.toThrow(
      ForbiddenError,
    );
  });
});
