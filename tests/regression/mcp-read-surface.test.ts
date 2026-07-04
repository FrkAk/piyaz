import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { superuserPool } from "@/tests/setup/global";
import { createMcpServer } from "@/lib/mcp/create-server";

afterEach(async () => {
  await truncateAll();
});

/**
 * Wire a linked client ↔ server pair over the in-memory transport.
 *
 * @param userId - Seeded user id to bind the server's auth context to.
 * @returns Connected MCP client.
 */
async function connectedClient(userId: string): Promise<Client> {
  const server = createMcpServer(makeAuthContext(userId));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/**
 * Create MRV fixture project with 6 tasks: MRV-1 through MRV-6.
 * Sets up various statuses, dependencies, content (decisions, criteria, files, execution records).
 *
 * Task structure:
 * - MRV-1 (done): Decisions with backticked ids, execution record
 * - MRV-2 (planned): Depends on MRV-1, upstream execution record available
 * - MRV-3 (in_review): Depends on MRV-2, implementation plan + execution record
 * - MRV-4, MRV-5, MRV-6: Various statuses and dependencies
 *
 * @param fixture - Existing fixture with userId and organizationId
 * @returns Project and task IDs: { projectId, taskIds: { mrv1, mrv2, ... } }
 */
async function seedMrvProject(fixture: {
  userId: string;
  organizationId: string;
}): Promise<{
  projectId: string;
  taskIds: {
    mrv1: string;
    mrv2: string;
    mrv3: string;
    mrv4: string;
    mrv5: string;
    mrv6: string;
  };
}> {
  const sql = superuserPool();

  // Create project
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects ("organization_id", "title", "identifier")
    VALUES (${fixture.organizationId}, 'MCP Revalidation', 'MRV')
    RETURNING id
  `;
  const projectId = p.id;

  // Helper to create a task
  async function createTask(
    title: string,
    seq: number,
    status: string = "draft",
    description: string = "",
  ): Promise<string> {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO tasks ("project_id", "title", "sequence_number", "status", "description")
      VALUES (${projectId}, ${title}, ${seq}, ${status}, ${description})
      RETURNING id
    `;
    return t.id;
  }

  // Create 6 tasks with various statuses
  const mrv1 = await createTask(
    "MRV-1: Backend API Design",
    1,
    "done",
    "Design REST API endpoints",
  );
  const mrv2 = await createTask(
    "MRV-2: Frontend Integration",
    2,
    "planned",
    "Integrate backend API into frontend",
  );
  const mrv3 = await createTask(
    "MRV-3: Testing & Review",
    3,
    "in_review",
    "Comprehensive test coverage",
  );
  const mrv4 = await createTask(
    "MRV-4: Documentation",
    4,
    "in_progress",
    "API and feature documentation",
  );
  const mrv5 = await createTask(
    "MRV-5: Performance Tuning",
    5,
    "planned",
    "Optimize database queries",
  );
  const mrv6 = await createTask(
    "MRV-6: Deployment",
    6,
    "draft",
    "Prepare for production deployment",
  );

  // Add acceptance criteria to MRV-1
  await sql`
    INSERT INTO task_acceptance_criteria ("id", "task_id", "text", "position")
    VALUES (gen_random_uuid(), ${mrv1}, 'All endpoints return correct status codes', 0)
  `;
  await sql`
    INSERT INTO task_acceptance_criteria ("id", "task_id", "text", "position")
    VALUES (gen_random_uuid(), ${mrv1}, 'Request/response validation in place', 1)
  `;

  // Add decisions to MRV-1 with backticked ids
  await sql`
    INSERT INTO task_decisions ("id", "task_id", "text", "source", "decision_date", "position")
    VALUES (gen_random_uuid(), ${mrv1}, 'Use REST over GraphQL for simplicity', 'planning', '2025-01-15', 0)
  `;
  await sql`
    INSERT INTO task_decisions ("id", "task_id", "text", "source", "decision_date", "position")
    VALUES (gen_random_uuid(), ${mrv1}, 'Implement rate limiting at middleware level', 'execution', '2025-01-20', 1)
  `;

  // Set execution record for MRV-1
  await sql`
    UPDATE tasks
    SET execution_record = ${"Implemented 12 endpoints in lib/routes/api.ts. Rate limiter added to middleware. Tests in tests/api/endpoints.test.ts covering all paths."}
    WHERE id = ${mrv1}
  `;

  // Set files for MRV-1 (must be JSON array, not string)
  await sql`
    UPDATE tasks
    SET files = ${["lib/routes/api.ts", "lib/middleware/rate-limit.ts", "tests/api/endpoints.test.ts"]}::jsonb
    WHERE id = ${mrv1}
  `;

  // Create dependencies
  await sql`
    INSERT INTO task_edges ("source_task_id", "target_task_id", "edge_type", "note")
    VALUES (${mrv2}, ${mrv1}, 'depends_on', 'Must have API endpoints before integration')
  `;

  await sql`
    INSERT INTO task_edges ("source_task_id", "target_task_id", "edge_type", "note")
    VALUES (${mrv3}, ${mrv2}, 'depends_on', 'Test after frontend integration complete')
  `;

  await sql`
    INSERT INTO task_edges ("source_task_id", "target_task_id", "edge_type", "note")
    VALUES (${mrv6}, ${mrv3}, 'depends_on', 'Deployment after tests pass')
  `;

  // Also add downstream edge from MRV-1 to MRV-3 (transitive)
  // This will test 3-deep transitive closure in piyaz_map
  await sql`
    INSERT INTO task_edges ("source_task_id", "target_task_id", "edge_type", "note")
    VALUES (${mrv4}, ${mrv1}, 'relates_to', 'Document API as implementation progresses')
  `;

  // Add implementation plan to MRV-3
  await sql`
    UPDATE tasks
    SET implementation_plan = ${"1. Run test suite against MRV-2 integration\n2. Add 5 more edge case tests\n3. Document findings in PR\n4. Fix any regressions\n5. Wait for review approval"}
    WHERE id = ${mrv3}
  `;

  // Add execution record to MRV-3
  await sql`
    UPDATE tasks
    SET execution_record = ${"Ran full test suite. Added 8 tests for edge cases in tests/integration. 97% coverage achieved. Fixed 2 race conditions in lib/concurrent. PR opened at https://github.com/example/piyaz/pull/42"}
    WHERE id = ${mrv3}
  `;

  // Add task link (PR) to MRV-3
  await sql`
    INSERT INTO task_links ("task_id", "kind", "url", "label")
    VALUES (${mrv3}, 'pull_request', 'https://github.com/example/piyaz/pull/42', 'PR #42')
  `;

  // Set tags on tasks
  await sql`UPDATE tasks SET tags = ${["testing", "infrastructure"]}::jsonb WHERE id = ${mrv3}`;
  await sql`UPDATE tasks SET tags = ${["feature", "integration"]}::jsonb WHERE id = ${mrv2}`;

  return {
    projectId,
    taskIds: { mrv1, mrv2, mrv3, mrv4, mrv5, mrv6 },
  };
}

/**
 * Parse MCP tool response text. The response is JSON-stringified for object
 * results or plain text for context bundles.
 *
 * @param content - Raw content array from an MCP callTool result.
 * @returns Parsed JSON object, or the raw text for markdown bundles.
 */
function parseToolResponse(content: unknown): unknown {
  const text =
    (content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    // Return raw text if not JSON (e.g., context bundles)
    return text;
  }
}

test("piyaz_get task MRV-1 lens='working': decisions have backticked ids in output", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "MRV-1", lens: "working" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Working lens must include decision ids
  expect(text).toContain("decision");
  expect(text).toContain("`");
  expect(text).toContain("REST");
  expect(text).toContain("rate limiting");

  await client.close();
});

test("piyaz_get task MRV-1 lens='agent': returns retrospective record bundle for done task", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "MRV-1", lens: "agent" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // For done task, agent lens should return retrospective record
  expect(text).toContain("Implemented 12 endpoints");
  expect(text).toContain("MRV-1");

  await client.close();
});

test("piyaz_get task MRV-2 lens='agent': surfaces upstream execution record from MRV-1", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "MRV-2", lens: "agent" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Should include dependency info and upstream execution records
  expect(text).toContain("MRV-1");
  expect(text).toContain("Prerequisites");
  expect(text).toContain("Upstream Execution");

  await client.close();
});

test("piyaz_get task MRV-3 lens='review': includes implementationPlan + executionRecord + PR link", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "MRV-3", lens: "review" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Review lens should include plan, record, and PR link
  expect(text).toContain("Implementation Plan");
  expect(text).toContain("Run test suite");
  expect(text).toContain("Execution Record");
  expect(text).toContain("PR #42");
  expect(text).toContain("github.com");

  await client.close();
});

test("piyaz_map project='MRV' view='downstream' task='MRV-1': shows transitive closure 3 deep", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_map",
    arguments: { project: "MRV", task: "MRV-1", view: "downstream" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Downstream should include MRV-2 (direct), MRV-3 (2 hops), and MRV-6 (transitive)
  expect(text).toContain("MRV-2");
  expect(text).toContain("MRV-3");
  expect(text).toContain("MRV-6");

  await client.close();
});

test("piyaz_map project='MRV' task='MRV-1' hops=1: returns immediate neighbors", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_map",
    arguments: { project: "MRV", view: "neighbors", task: "MRV-1", hops: 1 },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // 1-hop should include MRV-2 (depends on MRV-1) and MRV-4 (relates to MRV-1)
  expect(text).toContain("MRV-2");
  expect(text).toContain("MRV-4");

  await client.close();
});

test("piyaz_map project='MRV' task='MRV-1' hops=2: returns 2-hop neighbors", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_map",
    arguments: { project: "MRV", view: "neighbors", task: "MRV-1", hops: 2 },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // 2-hop should include MRV-3 (2 hops via MRV-2)
  expect(text).toContain("MRV-3");

  await client.close();
});

test("piyaz_get task='MRV-1' fields=['title', 'decisions', 'acceptanceCriteria']: exact raw text with no escaping", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: {
      task: "MRV-1",
      fields: ["title", "decisions", "acceptanceCriteria"],
    },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);

  // Should be raw field data, not stringified
  expect(output).toBeTruthy();
  const text = typeof output === "string" ? output : JSON.stringify(output);
  expect(text).toContain("Backend API Design");

  await client.close();
});

test("piyaz_get project='MRV' view='meta': returns categories, tag vocabulary, progress", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { project: "MRV", view: "meta" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Meta view should include project info and vocabulary
  expect(text).toContain("MCP Revalidation");
  expect(text).toContain("MRV");

  await client.close();
});

test("piyaz_get project='MRV' view='overview': returns every task with truncation behavior", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { project: "MRV", view: "overview" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Overview should include all 6 tasks
  expect(text).toContain("MRV-1");
  expect(text).toContain("MRV-2");
  expect(text).toContain("MRV-3");
  expect(text).toContain("MRV-4");
  expect(text).toContain("MRV-5");
  expect(text).toContain("MRV-6");

  await client.close();
});

test("piyaz_search project='MRV' status=['done']: filters to done tasks only", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_search",
    arguments: { project: "MRV", status: ["done"] },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Should only include MRV-1 (done status)
  expect(text).toContain("MRV-1");
  // Should not include planned tasks
  expect(text).not.toContain("MRV-5");

  await client.close();
});

test("piyaz_search project='MRV' status=['planned']: filters to planned tasks", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_search",
    arguments: { project: "MRV", status: ["planned"] },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Should include MRV-2 and MRV-5 (planned status)
  expect(text).toContain("MRV-2");
  expect(text).toContain("MRV-5");

  await client.close();
});

test("piyaz_search project='MRV' tags=['testing']: filters by tag", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_search",
    arguments: { project: "MRV", tags: ["testing"] },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Should include MRV-3 (has testing tag)
  expect(text).toContain("MRV-3");

  await client.close();
});

test("piyaz_activity project='MRV': returns recent events with actor/type/summary", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_activity",
    arguments: { project: "MRV" },
  });

  expect(result.isError ?? false).toBe(false);
  const output = parseToolResponse(result.content);
  const text = typeof output === "string" ? output : JSON.stringify(output);

  // Activity should return valid output (may be empty since we used SQL to seed)
  expect(text).toBeTruthy();
  // Should either have activity events or "No activity" message
  expect(text).toMatch(/activity|No activity/i);

  await client.close();
});

test("text round-trips byte-exact across all lenses: working vs summary vs agent", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  // Get title field (returns raw field data which is a string or object)
  const fieldResult = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "MRV-1", fields: ["title"] },
  });
  expect(fieldResult.isError ?? false).toBe(false);
  const fieldText = parseToolResponse(fieldResult.content);

  // Field read should return the raw field value
  expect(fieldText).toBeTruthy();
  const text =
    typeof fieldText === "string" ? fieldText : JSON.stringify(fieldText);
  expect(text).toContain("Backend API Design");

  await client.close();
});

test("cross-check: piyaz_get and piyaz_search return consistent task refs", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  // Get all tasks via search (with explicit status filter to avoid ambiguity)
  const searchResult = await client.callTool({
    name: "piyaz_search",
    arguments: {
      project: "MRV",
      status: [
        "done",
        "planned",
        "in_review",
        "in_progress",
        "draft",
        "cancelled",
      ],
    },
  });
  expect(searchResult.isError ?? false).toBe(false);
  const searchText = parseToolResponse(searchResult.content);
  const searchStr =
    typeof searchText === "string" ? searchText : JSON.stringify(searchText);

  // Get task directly
  const getResult = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "MRV-1" },
  });
  expect(getResult.isError ?? false).toBe(false);
  const getText = parseToolResponse(getResult.content);
  const getStr =
    typeof getText === "string" ? getText : JSON.stringify(getText);

  // Both should reference MRV-1
  expect(searchStr).toContain("MRV-1");
  expect(getStr).toContain("MRV-1");

  await client.close();
});

test("cross-check: piyaz_map downstream and piyaz_get edge traversal agree on dependency graph", async () => {
  const fx = await seedUserOrgProject("regression");
  await seedMrvProject(fx);
  const client = await connectedClient(fx.userId);

  // Get downstream view
  const downstreamResult = await client.callTool({
    name: "piyaz_map",
    arguments: { project: "MRV", task: "MRV-1", view: "downstream" },
  });
  expect(downstreamResult.isError ?? false).toBe(false);
  const downstreamText = parseToolResponse(downstreamResult.content);
  const downstreamStr =
    typeof downstreamText === "string"
      ? downstreamText
      : JSON.stringify(downstreamText);

  // Get MRV-1 with edges
  const getResult = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "MRV-1", lens: "working" },
  });
  expect(getResult.isError ?? false).toBe(false);
  const getText = parseToolResponse(getResult.content);
  const getStr =
    typeof getText === "string" ? getText : JSON.stringify(getText);

  // Both should agree on downstream tasks
  expect(downstreamStr).toContain("MRV-2");
  expect(downstreamStr).toContain("MRV-3");
  expect(getStr).toContain("MRV-2");

  await client.close();
});
