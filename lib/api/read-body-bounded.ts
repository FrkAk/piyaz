/**
 * Read a request body up to `maxBytes`, cancelling the stream as soon as
 * the cap is crossed. `request.arrayBuffer()` would buffer the ENTIRE
 * stream into isolate memory before any size check could run — a chunked
 * (length-less) over-limit body would then defeat the cap's purpose on
 * memory-bounded runtimes (Workers isolates). Legitimate bodies cost the
 * same single buffering pass as before.
 *
 * @param request - Incoming request.
 * @param maxBytes - Inclusive byte ceiling.
 * @returns Body bytes, or null when the body exceeds `maxBytes`.
 */
export async function readBodyBounded(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
