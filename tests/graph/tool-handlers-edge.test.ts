import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { handleEdge } from "@/lib/graph/tool-handlers";
import { makeAuthContext } from "@/lib/auth/context";

/**
 * The MCP edge-note description claims the placeholders 'needed', 'depends',
 * and 'related' are rejected. Verify the runtime check matches the contract.
 */

afterEach(async () => {
  await truncateAll();
});

async function seedTwoTasks() {
  const fx = await seedUserOrgProject("edge-placeholder");
  const sr = serviceRoleConnect();
  try {
    const [a] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, status)
      VALUES (${fx.projectId}, 'Source', 1, 'planned')
      RETURNING id`;
    const [b] = await sr<{ id: string }[]>`
      INSERT INTO tasks (project_id, title, sequence_number, status)
      VALUES (${fx.projectId}, 'Target', 2, 'planned')
      RETURNING id`;
    return { fx, sourceId: a.id, targetId: b.id };
  } finally {
    await sr.end({ timeout: 5 });
  }
}

for (const placeholder of ["needed", "depends", "related", " Needed ", "DEPENDS"]) {
  test(`handleEdge create rejects placeholder note "${placeholder}"`, async () => {
    const { fx, sourceId, targetId } = await seedTwoTasks();
    const ctx = makeAuthContext(fx.userId);

    const result = await handleEdge(
      {
        action: "create",
        sourceTaskId: sourceId,
        targetTaskId: targetId,
        edgeType: "depends_on",
        note: placeholder,
      } as never,
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/Placeholder edge notes/i);
    }
  });
}

test("handleEdge create accepts a substantive note", async () => {
  const { fx, sourceId, targetId } = await seedTwoTasks();
  const ctx = makeAuthContext(fx.userId);

  const result = await handleEdge(
    {
      action: "create",
      sourceTaskId: sourceId,
      targetTaskId: targetId,
      edgeType: "depends_on",
      note: "Reuses the upload contract shipped by the target task.",
    } as never,
    ctx,
  );

  expect(result.ok).toBe(true);
});
