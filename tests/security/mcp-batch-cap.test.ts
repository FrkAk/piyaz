import { test, expect } from "bun:test";
import { POST } from "@/app/api/mcp/route";
import { MAX_JSON_RPC_BATCH, isOversizedBatch } from "@/lib/mcp/batch";

/**
 * Attack-path coverage for JSON-RPC batching on the MCP endpoint.
 *
 * The middleware budget counts one unit per HTTP request, while the transport
 * dispatches every element of a batch array to a tool handler with its own RLS
 * transaction. Without a ceiling the advertised per-call quota bounds requests
 * rather than work, so one token can issue orders of magnitude more
 * DB-touching operations than the quota implies.
 */

/**
 * Encode a JSON-RPC batch of the given length as request bytes.
 *
 * @param count - Number of messages in the batch.
 * @returns UTF-8 bytes of the batch body.
 */
function batchBody(count: number): Uint8Array {
  const messages = Array.from({ length: count }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "tools/call",
    params: { name: "piyaz_search", arguments: { query: "a" } },
  }));
  return new TextEncoder().encode(JSON.stringify(messages));
}

test("attack: a batch beyond the ceiling is rejected", () => {
  expect(isOversizedBatch(batchBody(5_000))).toBe(true);
  expect(isOversizedBatch(batchBody(MAX_JSON_RPC_BATCH + 1))).toBe(true);
});

test("batches a client actually sends are accepted", () => {
  expect(isOversizedBatch(batchBody(1))).toBe(false);
  expect(isOversizedBatch(batchBody(MAX_JSON_RPC_BATCH))).toBe(false);
});

test("a single non-batch message is not treated as a batch", () => {
  const body = new TextEncoder().encode(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  );
  expect(isOversizedBatch(body)).toBe(false);
});

test("malformed bodies are left to the transport to diagnose", () => {
  expect(isOversizedBatch(new TextEncoder().encode("{not json"))).toBe(false);
  expect(isOversizedBatch(new Uint8Array(0))).toBe(false);
});

test("an unauthenticated batch is refused before any body work", async () => {
  const response = await POST(
    new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-a-real-token",
      },
      body: new TextDecoder().decode(batchBody(5_000)),
    }),
  );

  expect(response.status).toBe(401);
});
