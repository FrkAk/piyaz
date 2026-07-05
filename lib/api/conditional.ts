/**
 * Build a strong ETag from a resource validator. A `Date` renders as its
 * base-10 millisecond count — exact-string comparison preserves the
 * same-second mutation window that `Last-Modified`/`If-Modified-Since`
 * collapses (HTTP-date is 1-second resolution). A `string` is an opaque
 * pre-formatted token for composite validators (e.g. the notes tree's
 * `${maxUpdatedAt}-${liveCount}` pair) and is quoted verbatim. Either way
 * the value is opaque to clients and deterministic per resource state.
 *
 * @param validator - Server-side max `updatedAt` or an opaque token.
 * @returns Quoted ETag value suitable for the `ETag` response header.
 */
export function makeEtag(validator: Date | string): string {
  const token = typeof validator === "string" ? validator : validator.getTime();
  return `"${token}"`;
}

/**
 * Whether the request's `If-None-Match` validator matches the supplied
 * ETag. Strong byte-exact comparison per RFC 7232 §2.3.2 — we don't
 * emit weak ETags so the weak-comparison branch is never exercised.
 * Comma-separated lists (`If-None-Match: "a", "b"`) and the wildcard
 * `*` are both supported.
 *
 * @param req - Incoming request (Web Request or NextRequest).
 * @param validator - Server-side max `updatedAt` or an opaque token.
 * @returns True when any client-supplied validator matches the resource's
 *   current ETag (i.e. the response can be a 304); false otherwise.
 */
export function etagMatches(req: Request, validator: Date | string): boolean {
  const inm = req.headers.get("if-none-match");
  if (!inm) return false;
  if (inm.trim() === "*") return true;
  const etag = makeEtag(validator);
  return inm.split(",").some((part) => part.trim() === etag);
}

/**
 * Shared response headers — `private` keeps the payload off shared caches,
 * `no-cache` instructs the browser to always revalidate with the server
 * (an `If-None-Match` request) before reusing the cached response.
 * Together they make the conditional-GET contract explicit instead of
 * relying on browser heuristic freshness.
 */
const CACHE_HEADERS = { "Cache-Control": "private, no-cache" } as const;

/**
 * Build a 200 / 304 response based on `If-None-Match` semantics
 * (RFC 7232). Sets `ETag` on every response so the client can cache the
 * validator and present it on the next request.
 *
 * @param req - Incoming request (Web Request or NextRequest).
 * @param body - Response body for the 200 path. Pass `null` for HEAD.
 * @param validator - Server-side max `updatedAt` or an opaque token.
 * @returns 304 with no body when {@link etagMatches} is true; otherwise
 *   200 with the body. HEAD always returns a null body regardless of the
 *   200/304 branch.
 */
export function conditionalRespond<T>(
  req: Request,
  body: T,
  validator: Date | string,
): Response {
  const etag = makeEtag(validator);
  const baseHeaders = { ETag: etag, ...CACHE_HEADERS };

  if (etagMatches(req, validator)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: baseHeaders });
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...baseHeaders, "Content-Type": "application/json" },
  });
}
