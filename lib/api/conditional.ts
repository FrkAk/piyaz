/**
 * Build a 200 / 304 response based on `If-Modified-Since` semantics
 * (RFC 7232). Sets `Last-Modified` on every response so the client can
 * cache the validator and present it on the next request.
 *
 * HTTP-date headers carry one-second resolution; Postgres `timestamptz`
 * carries microseconds. The comparison floors both sides to whole seconds
 * so a round-trip through `toUTCString()` does not produce spurious 200s.
 *
 * @param req - Incoming request (Web Request or NextRequest).
 * @param body - Response body for the 200 path. Pass `null` for HEAD.
 * @param lastModified - Server-side max `updatedAt` for the resource.
 * @returns 304 with no body when the client's `If-Modified-Since` is at
 *   or after `lastModified`; otherwise 200 with the body. HEAD always
 *   returns a null body regardless of the 200/304 branch.
 */
export function conditionalRespond<T>(
  req: Request,
  body: T,
  lastModified: Date,
): Response {
  const lm = lastModified.toUTCString();
  const ifModifiedSince = req.headers.get("if-modified-since");

  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince).getTime();
    if (
      Number.isFinite(since) &&
      Math.floor(lastModified.getTime() / 1000) <= Math.floor(since / 1000)
    ) {
      return new Response(null, {
        status: 304,
        headers: { "Last-Modified": lm },
      });
    }
  }

  if (req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { "Last-Modified": lm },
    });
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Last-Modified": lm,
      "Content-Type": "application/json",
    },
  });
}
