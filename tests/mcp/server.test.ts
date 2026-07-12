import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { createMcpServer } from "@/lib/mcp/create-server";
import { setBackend, type RateLimitBackend } from "@/lib/api/rate-limit";
import { MemoryRateLimitBackend } from "@/lib/api/rate-limit-memory";

/** Deny-all stub for the heavy slot — deterministic, no 21-call warm-up. */
const exhaustedHeavyBackend: RateLimitBackend = {
  check: async () => ({ allowed: false, limit: 20, remaining: 0, resetIn: 42 }),
};

afterEach(async () => {
  setBackend("mcpHeavy", new MemoryRateLimitBackend(60_000));
  await truncateAll();
});

/**
 * Wire a linked client ↔ server pair over the in-memory transport. Proves
 * tool registration, schema serialization, and the toMcp response path
 * without HTTP or JWT plumbing.
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

test("listTools returns exactly the 9 tools with titles", async () => {
  const fx = await seedUserOrgProject("MCPLIST");
  const client = await connectedClient(fx.userId);

  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "piyaz_activity",
    "piyaz_create",
    "piyaz_edit",
    "piyaz_get",
    "piyaz_link",
    "piyaz_map",
    "piyaz_note",
    "piyaz_search",
    "piyaz_workspace",
  ]);
  for (const tool of tools) {
    expect(tool.description?.length ?? 0).toBeGreaterThan(50);
    expect(tool.annotations?.title).toBeTruthy();
    expect(
      Object.keys(tool.inputSchema.properties ?? {}).length,
    ).toBeGreaterThan(0);
  }
  await client.close();
});

test("callTool round-trips a get-by-ref through the transport", async () => {
  const fx = await seedUserOrgProject("MCPGET");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Transport probe",
    description: "Round-trips through the in-memory transport pair.",
  });
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "PRJMCPGET-1", lens: "summary" },
  });
  expect(result.isError ?? false).toBe(false);
  const text = (result.content as { type: string; text: string }[])[0].text;
  expect(text).toContain("Transport probe");
  expect(text).toContain("`PRJMCPGET-1`");
  await client.close();
});

test("callTool rejects schema-invalid arguments as a tool error", async () => {
  const fx = await seedUserOrgProject("MCPZOD");
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_map",
    arguments: { view: "not-a-view" },
  });
  expect(result.isError).toBe(true);
  await client.close();
});

test("callTool surfaces handler failures with corrective copy", async () => {
  const fx = await seedUserOrgProject("MCPERR");
  const client = await connectedClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_get",
    arguments: { task: "PRJMCPERR-42" },
  });
  expect(result.isError).toBe(true);
  const text = (result.content as { type: string; text: string }[])[0].text;
  expect(text).toContain("piyaz_search");
  await client.close();
});

test("heavy shapes are rejected when the heavy budget is exhausted", async () => {
  const fx = await seedUserOrgProject("MCPHEAVY");
  setBackend("mcpHeavy", exhaustedHeavyBackend);
  const client = await connectedClient(fx.userId);

  const heavyCalls = [
    { name: "piyaz_get", arguments: { task: "PRJMCPHEAVY-1", lens: "agent" } },
    {
      name: "piyaz_map",
      arguments: { view: "critical_path", project: "PRJMCPHEAVY" },
    },
    {
      name: "piyaz_map",
      arguments: { view: "neighbors", task: "PRJMCPHEAVY-1", hops: 2 },
    },
  ];
  for (const call of heavyCalls) {
    const result = await client.callTool(call);
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("Heavy-tier budget exhausted");
    expect(text).toContain("Retry in 42s");
  }
  await client.close();
});

test("heavy gate rejects a large create batch before any write", async () => {
  const fx = await seedUserOrgProject("MCPHVYCR");
  setBackend("mcpHeavy", exhaustedHeavyBackend);
  const client = await connectedClient(fx.userId);

  const tasks = Array.from({ length: 6 }, (_, i) => ({
    title: `Batch probe ${i + 1}`,
    description: "Part of the throttled batch. Must never land.",
  }));
  const created = await client.callTool({
    name: "piyaz_create",
    arguments: { project: "PRJMCPHVYCR", tasks },
  });
  expect(created.isError).toBe(true);
  const createdText = (created.content as { type: string; text: string }[])[0]
    .text;
  expect(createdText).toContain("Heavy-tier budget exhausted");

  const search = await client.callTool({
    name: "piyaz_search",
    arguments: { query: "Batch probe" },
  });
  expect(search.isError ?? false).toBe(false);
  const searchText = (search.content as { type: string; text: string }[])[0]
    .text;
  expect(searchText).toContain("No results");
  await client.close();
});

test("category cascades are rejected when the heavy budget is exhausted", async () => {
  const fx = await seedUserOrgProject("MCPHVYWS");
  setBackend("mcpHeavy", exhaustedHeavyBackend);
  const client = await connectedClient(fx.userId);

  const cascadeCalls = [
    {
      name: "piyaz_workspace",
      arguments: {
        action: "rename_category",
        project: "PRJMCPHVYWS",
        category: "backend",
        newCategory: "api",
      },
    },
    {
      name: "piyaz_workspace",
      arguments: {
        action: "delete_category",
        project: "PRJMCPHVYWS",
        category: "backend",
      },
    },
  ];
  for (const call of cascadeCalls) {
    const result = await client.callTool(call);
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("Heavy-tier budget exhausted");
  }

  const update = await client.callTool({
    name: "piyaz_workspace",
    arguments: {
      action: "update",
      project: "PRJMCPHVYWS",
      title: "Still writable",
    },
  });
  expect(update.isError ?? false).toBe(false);
  await client.close();
});

test("light shapes pass with the heavy budget exhausted", async () => {
  const fx = await seedUserOrgProject("MCPLIGHT");
  const ctx = makeAuthContext(fx.userId);
  await createTask(ctx, {
    projectId: fx.projectId,
    title: "Light probe",
    description: "Reads fine under a drained heavy budget. Cheap shape.",
  });
  setBackend("mcpHeavy", exhaustedHeavyBackend);
  const client = await connectedClient(fx.userId);

  const lightCalls = [
    { name: "piyaz_get", arguments: { task: "PRJMCPLIGHT-1" } },
    {
      name: "piyaz_get",
      arguments: { task: "PRJMCPLIGHT-1", lens: "agent", fields: ["title"] },
    },
    { name: "piyaz_map", arguments: { view: "ready", project: "PRJMCPLIGHT" } },
  ];
  for (const call of lightCalls) {
    const result = await client.callTool(call);
    expect(result.isError ?? false).toBe(false);
  }
  await client.close();
});

/**
 * Wire a client whose server context carries an mcp-source actor, the only
 * actor shape the consent gate applies to.
 *
 * @param userId - Seeded user id to bind the server's auth context to.
 * @returns Connected MCP client.
 */
async function connectedMcpActorClient(userId: string): Promise<Client> {
  const server = createMcpServer(
    makeAuthContext(userId, { source: "mcp", userId, clientId: "test-mcp" }),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

test("consent gate blocks every tool for an mcp actor with outstanding re-consent", async () => {
  const fx = await seedUserOrgProject("MCPGATE", { legalCurrent: false });
  const client = await connectedMcpActorClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_workspace",
    arguments: { action: "whoami" },
  });
  expect(result.isError).toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  expect(text).toContain("terms_acceptance_required");
  expect(text).toContain("/legal/accept");
  await client.close();
});

test("consent gate passes an mcp actor current on both documents", async () => {
  const fx = await seedUserOrgProject("MCPGATEOK");
  const client = await connectedMcpActorClient(fx.userId);

  const result = await client.callTool({
    name: "piyaz_workspace",
    arguments: { action: "whoami" },
  });
  expect(result.isError ?? false).toBe(false);
  await client.close();
});
