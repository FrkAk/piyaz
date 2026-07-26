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

/**
 * Whether a decoded request body is a JSON-RPC batch larger than the ceiling.
 *
 * Malformed JSON is not judged here: the transport owns that error, and
 * returning its own JSON-RPC diagnostic beats a shape complaint from the edge
 * of the route.
 *
 * @param body - Raw request body bytes.
 * @returns `true` when the body is an over-sized batch array.
 */
export function isOversizedBatch(body: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return Array.isArray(parsed) && parsed.length > MAX_JSON_RPC_BATCH;
  } catch {
    return false;
  }
}
