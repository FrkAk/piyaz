import { afterEach, expect, test } from "bun:test";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject, serviceRoleConnect } from "@/tests/setup/seed";
import { handleProject } from "@/lib/graph/tool-handlers";
import { makeAuthContext } from "@/lib/auth/context";

/**
 * Drizzle ≥0.44 wraps every driver error in `DrizzleQueryError` with the
 * postgres-js fields (`code`, `constraint_name`, …) parked on `.cause`. A
 * shallow `e.code === "23505"` check therefore misses real unique
 * violations and the request falls through to the generic catch-all that
 * echoes the raw query when NODE_ENV === "development". This pins the
 * cause-walking helper at the MCP boundary so duplicate identifiers
 * always surface as a clean, actionable conflict message.
 */

afterEach(async () => {
  await truncateAll();
});

test("handleProject create surfaces clean conflict on duplicate identifier", async () => {
  const fx = await seedUserOrgProject("conflict-identifier");
  const ctx = makeAuthContext(fx.userId);

  const sr = serviceRoleConnect();
  try {
    await sr`
      INSERT INTO projects ("organization_id", "title", "identifier")
      VALUES (${fx.organizationId}, 'Other', 'SMK')
    `;
  } finally {
    await sr.end({ timeout: 5 });
  }

  const result = await handleProject(
    {
      action: "create",
      title: "Smoke",
      identifier: "SMK",
      organizationId: fx.organizationId,
    } as never,
    ctx,
  );

  expect(result.ok).toBe(false);
  if (result.ok === false) {
    expect(result.error).toMatch(/identifier already in use/i);
    expect(result.error).not.toMatch(/insert into|select .* from/i);
  }
});
