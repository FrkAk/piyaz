/**
 * Most JSON-RPC messages accepted in one batched POST to `/api/mcp`.
 *
 * The transport dispatches every element of a batch array to a tool handler,
 * each opening its own RLS transaction, while the middleware budget counts the
 * POST once. Without a ceiling the advertised per-call quota bounds HTTP
 * requests rather than work, and a body inside the route's byte cap holds
 * several thousand minimal `tools/call` messages. Clients batch a handful of
 * messages at a time, so this is well clear of legitimate use.
 */
export const MAX_JSON_RPC_BATCH = 25;

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

/**
 * Whether a decoded request body is a JSON-RPC batch larger than the ceiling.
 *
 * Only an array can be over-sized, so the first non-whitespace byte decides
 * whether parsing is worth it. The transport parses the same bytes again
 * immediately after, and the common body is a single message, so skipping the
 * decode-and-parse for every non-batch request avoids doing that work twice
 * per call against the Worker's CPU ceiling.
 *
 * Malformed JSON is not judged here: the transport owns that error, and
 * returning its own JSON-RPC diagnostic beats a shape complaint from the edge
 * of the route.
 *
 * @param body - Raw request body bytes.
 * @returns `true` when the body is an over-sized batch array.
 */
export function isOversizedBatch(body: Uint8Array): boolean {
  let i = UTF8_BOM.every((byte, offset) => body[offset] === byte)
    ? UTF8_BOM.length
    : 0;
  while (i < body.length && JSON_WHITESPACE.has(body[i])) i++;
  if (body[i] !== OPEN_BRACKET) return false;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return Array.isArray(parsed) && parsed.length > MAX_JSON_RPC_BATCH;
  } catch {
    return false;
  }
}
