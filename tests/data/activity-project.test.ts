import { afterEach, describe, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createProject } from "@/lib/data/project";

afterEach(async () => {
  await truncateAll();
});

describe("project activity", () => {
  test("createProject records a project_created event", async () => {
    const fx = await seedUserOrgProject("proj-1");
    const ctx = makeAuthContext(fx.userId);
    const project = await createProject(ctx, {
      organizationId: fx.organizationId,
      title: "P",
    } as Parameters<typeof createProject>[1]);

    const sr = serviceRoleConnect();
    try {
      const rows = await sr`
        SELECT type, task_id FROM activity_events WHERE project_id = ${project.id}`;
      expect(rows.length).toBe(1);
      expect(rows[0].type).toBe("project_created");
      expect(rows[0].task_id).toBeNull();
    } finally {
      await sr.end({ timeout: 5 });
    }
  });
});
