import { test, expect } from "bun:test";
import { readBodyBounded } from "@/lib/api/read-body-bounded";

/**
 * Build a POST request whose body streams the given chunks.
 *
 * @param chunks - Byte chunks emitted by the body stream, in order.
 * @param onCancel - Invoked when the consumer cancels the stream.
 * @returns Request with a chunked (length-less) body.
 */
function streamRequest(chunks: Uint8Array[], onCancel?: () => void): Request {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request("http://localhost/api/mcp", { method: "POST", body });
}

const encode = (s: string) => new TextEncoder().encode(s);

test("a request without a body reads as zero bytes", async () => {
  const request = new Request("http://localhost/api/mcp", { method: "POST" });
  const body = await readBodyBounded(request, 10);
  expect(body).not.toBeNull();
  expect(body!.byteLength).toBe(0);
});

test("an under-limit body round-trips byte-identical", async () => {
  const request = streamRequest([encode("hello")]);
  const body = await readBodyBounded(request, 10);
  expect(body).not.toBeNull();
  expect(new TextDecoder().decode(body!)).toBe("hello");
});

test("a body exactly at the cap is accepted — the ceiling is inclusive", async () => {
  const request = streamRequest([encode("12345")]);
  const body = await readBodyBounded(request, 5);
  expect(body).not.toBeNull();
  expect(body!.byteLength).toBe(5);
});

test("a body one byte over the cap is rejected", async () => {
  const request = streamRequest([encode("123456")]);
  expect(await readBodyBounded(request, 5)).toBeNull();
});

test("multiple chunks reassemble in order", async () => {
  const request = streamRequest([encode("ab"), encode("cd"), encode("ef")]);
  const body = await readBodyBounded(request, 10);
  expect(new TextDecoder().decode(body!)).toBe("abcdef");
});

test("a chunked body crossing the cap mid-stream is rejected and cancelled", async () => {
  // A length-less chunked body must not be buffered past the cap: the
  // reject has to fire on the crossing chunk and cancel the stream so an
  // attacker cannot stream tens of megabytes into isolate memory.
  let cancelled = false;
  const request = streamRequest(
    [encode("aaaa"), encode("bbbb"), encode("cccc")],
    () => {
      cancelled = true;
    },
  );
  expect(await readBodyBounded(request, 6)).toBeNull();
  expect(cancelled).toBe(true);
});
