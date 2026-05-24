import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { handleQuery } from "@/lib/graph/tool-handlers";
import { makeAuthContext } from "@/lib/auth/context";

afterEach(async () => {
  await truncateAll();
});

async function seedProjectWithCategories(
  suffix: string,
  categories: string[],
): Promise<{ userId: string; projectId: string }> {
  const fx = await seedUserOrgProject(suffix);
  const sr = serviceRoleConnect();
  try {
    await sr`
      UPDATE projects
      SET categories = ${JSON.stringify(categories)}::jsonb
      WHERE id = ${fx.projectId}
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }
  return { userId: fx.userId, projectId: fx.projectId };
}

test("handleQuery search rejects unknown category with project vocabulary inline", async () => {
  const { userId, projectId } = await seedProjectWithCategories("queryunknown", [
    "MCP",
    "Data",
    "UI",
  ]);
  const ctx = makeAuthContext(userId);

  const result = await handleQuery(
    { type: "search", projectId, category: "NotACategory" },
    ctx,
  );

  expect(result.ok).toBe(false);
  if (result.ok === false) {
    expect(result.error).toContain('Category "NotACategory"');
    expect(result.error).toContain("MCP, Data, UI");
    expect(result.error).toContain("mymir_query type='meta'");
  }
});

test("handleQuery search accepts a known category alone and returns matching tasks", async () => {
  const { userId, projectId } = await seedProjectWithCategories("queryknown", [
    "MCP",
    "Data",
  ]);
  const ctx = makeAuthContext(userId);

  const sr = serviceRoleConnect();
  try {
    await sr`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "order", "tags", "category")
      VALUES
        (${projectId}, 'Alpha', 1, 10, '[]'::jsonb, 'MCP'),
        (${projectId}, 'Beta', 2, 20, '[]'::jsonb, 'Data')
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const result = await handleQuery(
    { type: "search", projectId, category: "MCP" },
    ctx,
  );
  expect(result.ok).toBe(true);
});

test("handleQuery search rejects when no filter is provided", async () => {
  const { userId, projectId } = await seedProjectWithCategories(
    "querynofilter",
    ["MCP"],
  );
  const ctx = makeAuthContext(userId);

  const result = await handleQuery({ type: "search", projectId }, ctx);

  expect(result.ok).toBe(false);
  if (result.ok === false) {
    expect(result.error).toContain("query, tags, or category required");
  }
});
