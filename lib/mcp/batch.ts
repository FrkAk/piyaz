/**
 * Most JSON-RPC messages accepted in one batched POST to `/api/mcp`.
 *
 * The transport dispatches every element of a batch array to a handler,
 * each `tools/call` opening its own RLS transaction, while the middleware
 * budget counts the POST once; the route charges the per-call meter for the
 * extra non-tool elements. MCP 2025-06-18 removed JSON-RPC batching, so the
 * array path exists only for 2025-03-26 back-compat and a small ceiling
 * penalizes no current client.
 */
export const MAX_JSON_RPC_BATCH = 5;

/** Bytes JSON permits before a value: space, tab, line feed, carriage return. */
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** Opening bracket, the only byte a batch can start with. */
const OPEN_BRACKET = 0x5b;

/**
 * UTF-8 byte order mark, skipped before the bracket check.
 *
 * `TextDecoder` strips it and so does the transport's `Request.json`, so a
 * body that opens with one still reaches a tool handler as a batch. Reading
 * the raw bytes has to strip it too, or prefixing a mark would carry an
 * over-sized batch past the ceiling.
 */
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** What {@link inspectBatch} learned about a request body. */
export type BatchInspection = {
  /** Whether the body is a batch larger than {@link MAX_JSON_RPC_BATCH}. */
  oversized: boolean;
  /** JSON-RPC messages the body carries; 1 for a single message. */
  count: number;
  /** The parsed body, present only when it parsed as an array. */
  parsed?: unknown;
};

/**
 * Standard-tier units a batch owes beyond the POST itself.
 *
 * `wrapTool` bills every `tools/call` individually, so only non-tool
 * messages count here, minus the one message the middleware's POST unit
 * already covers. A single message or an all-`tools/call` batch owes
 * nothing.
 *
 * @param inspection - The batch inspection result.
 * @returns Units to charge against the standard meter.
 */
export function batchSurcharge(inspection: BatchInspection): number {
  if (!Array.isArray(inspection.parsed)) return 0;
  const nonTool = inspection.parsed.filter(
    (message) =>
      typeof message !== "object" ||
      message === null ||
      (message as { method?: unknown }).method !== "tools/call",
  ).length;
  return Math.max(0, nonTool - 1);
}

/**
 * Inspect a request body for the JSON-RPC batch path.
 *
 * Only an array can be a batch, so the first non-whitespace byte decides
 * whether parsing is worth it; the common single-message body is never
 * decoded here. A parsed array is returned for reuse as the transport's
 * `parsedBody`, so batch bytes are parsed once.
 *
 * Malformed JSON is not judged here: the transport owns that error, and
 * `parsed` stays absent on a parse failure so the transport re-reads the
 * bytes and produces its own diagnostic.
 *
 * @param body - Raw request body bytes.
 * @returns The inspection result.
 */
export function inspectBatch(body: Uint8Array): BatchInspection {
  let i = UTF8_BOM.every((byte, offset) => body[offset] === byte)
    ? UTF8_BOM.length
    : 0;
  while (i < body.length && JSON_WHITESPACE.has(body[i])) i++;
  if (body[i] !== OPEN_BRACKET) return { oversized: false, count: 1 };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!Array.isArray(parsed)) return { oversized: false, count: 1 };
    return {
      oversized: parsed.length > MAX_JSON_RPC_BATCH,
      count: parsed.length,
      parsed,
    };
  } catch {
    return { oversized: false, count: 1 };
  }
}
