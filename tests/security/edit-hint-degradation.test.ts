import { test, expect, mock, afterEach } from "bun:test";
import * as realProject from "@/lib/data/project";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { isStatementTimeout } from "@/lib/db/errors";
import { translateError } from "@/lib/graph/tools/shared";

/**
 * Coverage for statement-timeout handling around committed writes.
 *
 * `translateError` tells the caller nothing was written, which is only true
 * while every 57014 it sees comes from a rolled-back transaction. `handleEdit`
 * reads project tags AFTER its write commits, so that read failing must
 * degrade to a hint-less success rather than an error inviting a retry of the
 * applied operation (an `op='append'` retried after commit duplicates the
 * appended body).
 */

let failTagRead = false;

/**
 * Build an error shaped like the driver's statement-timeout abort.
 *
 * @returns A 57014-coded error.
 */
function statementTimeout(): Error & { code: string } {
  const err = new Error(
    "canceling statement due to statement timeout",
  ) as Error & { code: string };
  err.code = "57014";
  return err;
}

mock.module("@/lib/data/project", () => ({
  ...realProject,
  getProjectTags: (async (
    ...args: Parameters<typeof realProject.getProjectTags>
  ) => {
    if (failTagRead) throw statementTimeout();
    return realProject.getProjectTags(...args);
  }) as typeof realProject.getProjectTags,
}));

const { handleEdit } = await import("@/lib/graph/tools/edit");

afterEach(async () => {
  failTagRead = false;
  await truncateAll();
});

test("57014 maps to the time-ceiling reply", () => {
  expect(isStatementTimeout(statementTimeout())).toBe(true);
  expect(isStatementTimeout(new Error("other"))).toBe(false);

  const result = translateError(statementTimeout());
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("time ceiling");
  }
});

test("a failed post-commit hint read degrades to a hint-less success", async () => {
  const fx = await seedUserOrgProject("THINTDEG");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, { projectId: fx.projectId, title: "Hint target" });

  failTagRead = true;
  const result = await handleEdit(
    {
      task: "PRJTHINTDEG-1",
      operations: [{ op: "set", field: "tags", value: ["backend"] }],
    },
    ctx,
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    const data = result.data as unknown as { updatedAt?: string };
    expect(data.updatedAt).toBeDefined();
  }
});
