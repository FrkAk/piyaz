import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { truncateAll } from "@/tests/setup/schema";
import { seedUserOrgProject } from "@/tests/setup/seed";
import { makeAuthContext } from "@/lib/auth/context";
import { createTask } from "@/lib/data/task";
import { createMcpServer } from "@/lib/mcp/create-server";

afterEach(async () => {
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

test("listTools returns exactly the 8 tools with titles", async () => {
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
