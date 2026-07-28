import { test, expect } from "bun:test";
import { POST } from "@/app/api/mcp/route";
import { MAX_JSON_RPC_BATCH, inspectBatch } from "@/lib/mcp/batch";

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
  expect(inspectBatch(batchBody(5_000)).oversized).toBe(true);
  expect(inspectBatch(batchBody(MAX_JSON_RPC_BATCH + 1)).oversized).toBe(true);
});

test("batches a client actually sends are accepted", () => {
  expect(inspectBatch(batchBody(1)).oversized).toBe(false);
  expect(inspectBatch(batchBody(MAX_JSON_RPC_BATCH)).oversized).toBe(false);
});

test("a single non-batch message is not treated as a batch", () => {
  const body = new TextEncoder().encode(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  );
  expect(inspectBatch(body).oversized).toBe(false);
});

test("attack: whitespace or a byte order mark cannot carry a batch past the cap", () => {
  // The byte scan that skips parsing for non-batch bodies has to strip the
  // same prefixes TextDecoder and the transport's Request.json strip, or a
  // prefixed body is waved through here and still dispatched as a batch.
  const batch = new TextDecoder().decode(batchBody(5_000));
  const encoder = new TextEncoder();

  expect(inspectBatch(encoder.encode(`\n\t  ${batch}`)).oversized).toBe(true);
  expect(inspectBatch(encoder.encode(`﻿${batch}`)).oversized).toBe(true);
  expect(inspectBatch(encoder.encode(`﻿  ${batch}`)).oversized).toBe(true);
});

test("inspection reports the batch size and returns the parse for reuse", () => {
  const single = inspectBatch(
    new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ),
  );
  expect(single.count).toBe(1);
  expect(single.parsed).toBeUndefined();

  const batch = inspectBatch(batchBody(3));
  expect(batch.count).toBe(3);
  expect(Array.isArray(batch.parsed)).toBe(true);
});

test("malformed bodies are left to the transport to diagnose", () => {
  expect(inspectBatch(new TextEncoder().encode("{not json")).oversized).toBe(
    false,
  );
  expect(inspectBatch(new Uint8Array(0)).oversized).toBe(false);
});

test("attack: a cross-origin browser request is refused before the token check", async () => {
  // DNS rebinding: a page the user visits resolves to this host and posts with
  // the browser's credentials attached. The transport spec requires 403 when
  // Origin is present and not ours.
  const response = await POST(
    new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        authorization: "Bearer not-a-real-token",
      },
      body: new TextDecoder().decode(batchBody(1)),
    }),
  );

  expect(response.status).toBe(403);
});

test("a client sending no origin header is not refused", async () => {
  // Agent clients are not browsers and send no Origin; they must still reach
  // the token check rather than being turned away at the door.
  const response = await POST(
    new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-real-token",
      },
      body: new TextDecoder().decode(batchBody(1)),
    }),
  );

  expect(response.status).toBe(401);
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
