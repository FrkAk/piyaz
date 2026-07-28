import { test, expect, mock, afterEach } from "bun:test";
import * as realOauth2 from "better-auth/oauth2";
import { MAX_JSON_RPC_BATCH } from "@/lib/mcp/batch";
import { MCP_STANDARD_LIMIT } from "@/lib/api/rate-limit";
import { makeAuthContext } from "@/lib/auth/context";

/**
 * Route-level coverage for MCP batch metering with an authenticated caller.
 *
 * The verifier is stubbed through a delegating module mock: with no stub
 * payload set it calls the real `verifyJwsAccessToken`, so the 401 paths in
 * sibling files keep their behavior; with one set, the route sees a verified
 * payload without minting a real token.
 */

let stubPayload: Record<string, unknown> | null = null;

mock.module("better-auth/oauth2", () => ({
  ...realOauth2,
  verifyJwsAccessToken: (async (
    ...args: Parameters<typeof realOauth2.verifyJwsAccessToken>
  ) =>
    stubPayload ??
    realOauth2.verifyJwsAccessToken(
      ...args,
    )) as typeof realOauth2.verifyJwsAccessToken,
}));

const { POST } = await import("@/app/api/mcp/route");
const { mcpCallerKey } = await import("@/lib/mcp/create-server");

afterEach(() => {
  stubPayload = null;
});

/** A syntactically JWT-shaped bearer token carrying a `kid` header. */
const FAKE_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test-kid" })).toString(
    "base64url",
  ),
  Buffer.from(JSON.stringify({})).toString("base64url"),
  "sig",
].join(".");

/**
 * POST a JSON-RPC body to the MCP route as the stubbed caller.
 *
 * @param body - JSON-serializable JSON-RPC message or batch.
 * @returns Route response.
 */
function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${FAKE_TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Build a `tools/list` batch of the given size.
 *
 * @param count - Number of messages.
 * @returns The batch array.
 */
function listBatch(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "tools/list",
  }));
}

test("attack: an oversized batch with a valid token is refused with 413", async () => {
  stubPayload = { sub: crypto.randomUUID(), azp: "batch-cap-client" };

  const response = await post(listBatch(MAX_JSON_RPC_BATCH + 1));
  expect(response.status).toBe(413);
});

test("attack: batched non-tool methods draw down the standard meter", async () => {
  stubPayload = { sub: crypto.randomUUID(), azp: "metering-client" };

  // Each batch charges its elements beyond the first against the per-caller
  // meter, so `tools/list` amplification exhausts the budget instead of
  // being free.
  const perBatch = MAX_JSON_RPC_BATCH - 1;
  const fullBatches = Math.floor(MCP_STANDARD_LIMIT.max / perBatch);
  for (let i = 0; i < fullBatches; i++) {
    const ok = await post(listBatch(MAX_JSON_RPC_BATCH));
    expect(ok.status).toBe(200);
  }

  const rejected = await post(listBatch(MAX_JSON_RPC_BATCH));
  expect(rejected.status).toBe(429);
});

test("a single message keeps the transport's parse path", async () => {
  stubPayload = { sub: crypto.randomUUID(), azp: "single-client" };

  const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(response.status).toBe(200);
});

test("standard budgets key per (user, client); the heavy tier keys per user", () => {
  const userId = crypto.randomUUID();
  const viaClient = makeAuthContext(userId, {
    source: "mcp",
    userId,
    clientId: "agent-a",
  });
  const otherClient = makeAuthContext(userId, {
    source: "mcp",
    userId,
    clientId: "agent-b",
  });
  const bare = makeAuthContext(userId);

  expect(mcpCallerKey(viaClient)).toBe(`${userId}:agent-a`);
  expect(mcpCallerKey(viaClient)).not.toBe(mcpCallerKey(otherClient));
  expect(mcpCallerKey(bare)).toBe(userId);
});
