import { test, expect, beforeEach, mock } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  _clearEtagCache,
  conditionalFetch,
  conditionalFetchPage,
} from "@/lib/query/conditional-fetch";

beforeEach(() => {
  _clearEtagCache();
});

type FetchArgs = Parameters<typeof globalThis.fetch>;

const fetchMock = (response: Response) => {
  const fn = mock((...args: FetchArgs) => {
    void args;
    return Promise.resolve(response);
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
};

const ETAG = `"1746612000000"`;
const ETAG_NEXT = `"1746612000800"`;

test("200 stores ETag and returns parsed body", async () => {
  const fn = fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { ETag: ETAG, "Content-Type": "application/json" },
    }),
  );
  const qc = new QueryClient();
  const data = await conditionalFetch<{ ok: number }>({
    url: "/api/x",
    queryKey: ["x"],
    queryClient: qc,
  });
  expect(data).toEqual({ ok: 1 });
  expect(fn).toHaveBeenCalledTimes(1);
  const firstCall = fn.mock.calls[0]!;
  const init = firstCall[1] as RequestInit;
  expect(init.headers).toEqual({});
  expect(init.cache).toBe("no-store");
});

test("subsequent request sends If-None-Match with stored value", async () => {
  const qc = new QueryClient();

  fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { ETag: ETAG },
    }),
  );
  await conditionalFetch({ url: "/api/x", queryKey: ["x"], queryClient: qc });

  const fn = fetchMock(new Response(null, { status: 304 }));
  qc.setQueryData(["x"], { ok: 1 });
  const data = await conditionalFetch<{ ok: number }>({
    url: "/api/x",
    queryKey: ["x"],
    queryClient: qc,
  });
  expect(data).toEqual({ ok: 1 });
  const reqCall = fn.mock.calls[0]!;
  expect((reqCall[1] as RequestInit).headers).toEqual({
    "If-None-Match": ETAG,
  });
});

test("304 with no Query cache refetches unconditionally and returns body", async () => {
  // Simulate the real-world failure mode: side-channel still has an
  // ETag, but Query has gc'd (or never had) the cached body. The helper
  // must not return undefined — it should drop the validator and
  // reissue the request to land a defined value.
  const qc = new QueryClient();

  // Seed the side-channel by completing one full 200 fetch.
  fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { ETag: ETAG },
    }),
  );
  await conditionalFetch({ url: "/api/x", queryKey: ["x"], queryClient: qc });
  // Drop Query's cache so the conditional path can't satisfy from there.
  qc.removeQueries({ queryKey: ["x"] });

  const responses: Response[] = [
    new Response(null, { status: 304 }),
    new Response(JSON.stringify({ ok: 2 }), {
      status: 200,
      headers: { ETag: ETAG_NEXT },
    }),
  ];
  let call = 0;
  const fn = mock((...args: FetchArgs) => {
    void args;
    return Promise.resolve(responses[call++]!);
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;

  const data = await conditionalFetch<{ ok: number }>({
    url: "/api/x",
    queryKey: ["x"],
    queryClient: qc,
  });
  expect(data).toEqual({ ok: 2 });
  expect(fn).toHaveBeenCalledTimes(2);
  const followUp = fn.mock.calls[1]!;
  const init = followUp[1] as RequestInit;
  // Follow-up request carries no validator so the server can't 304 again.
  expect(init.headers).toBeUndefined();
});

test("non-2xx/304 throws", async () => {
  fetchMock(new Response("nope", { status: 500, statusText: "Server Error" }));
  const qc = new QueryClient();
  await expect(
    conditionalFetch({ url: "/api/x", queryKey: ["x"], queryClient: qc }),
  ).rejects.toThrow("500");
});

test("side-channel drops ETag when Query removes the entry", async () => {
  // Root-cause guard for the 'side-channel outlives Query gcTime' failure
  // mode. After Query evicts a cache entry the matching validator must be
  // gone too, so the next fetch sends no `If-None-Match` and the server
  // can't 304 us into the no-cache trap.
  const qc = new QueryClient();

  fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { ETag: ETAG },
    }),
  );
  // Mirror the runtime path: useQuery would call the queryFn and Query
  // would cache the body. Here we drive that explicitly — conditionalFetch
  // populates the side-channel and we mirror the cache write so the cache
  // has an entry to remove.
  const body = await conditionalFetch<{ ok: number }>({
    url: "/api/x",
    queryKey: ["x"],
    queryClient: qc,
  });
  qc.setQueryData(["x"], body);

  qc.removeQueries({ queryKey: ["x"] });

  const fn = fetchMock(
    new Response(JSON.stringify({ ok: 2 }), {
      status: 200,
      headers: { ETag: ETAG_NEXT },
    }),
  );
  await conditionalFetch({ url: "/api/x", queryKey: ["x"], queryClient: qc });

  const init = fn.mock.calls[0]![1] as RequestInit;
  expect(init.headers).toEqual({});
});

test("page side-channel drops its ETag when the infinite query is removed", async () => {
  // conditionalFetchPage keys the validator by `[...queryKey, pageParam]`,
  // but an infinite query stores every page under the bare queryKey. When
  // Query evicts that key the per-page validators must go too, or the next
  // page-1 fetch sends a stale If-None-Match and 304s into a body it no
  // longer has cached.
  const qc = new QueryClient();
  const queryKey = ["projects", "list"] as const;

  fetchMock(
    new Response(JSON.stringify({ rows: [], nextCursor: null }), {
      status: 200,
      headers: { ETag: ETAG },
    }),
  );
  const page = await conditionalFetchPage<{
    rows: unknown[];
    nextCursor: string | null;
  }>({
    url: "/api/projects",
    queryKey,
    pageParam: null,
    queryClient: qc,
  });
  qc.setQueryData(queryKey, { pages: [page], pageParams: [null] });

  qc.removeQueries({ queryKey });

  const fn = fetchMock(
    new Response(JSON.stringify({ rows: [], nextCursor: null }), {
      status: 200,
      headers: { ETag: ETAG_NEXT },
    }),
  );
  await conditionalFetchPage({
    url: "/api/projects",
    queryKey,
    pageParam: null,
    queryClient: qc,
  });

  const init = fn.mock.calls[0]![1] as RequestInit;
  expect(init.headers).toEqual({});
});

test("removing a query does not drop a longer sibling key's ETag", async () => {
  // taskKeys.detail ["task",p,t] is a JSON prefix of taskKeys.context
  // ["task",p,t,"context"]. Evicting detail must NOT drop context's still-live
  // validator — otherwise the next context refetch sends no If-None-Match and
  // pays a full 200 instead of a bodiless 304.
  const qc = new QueryClient();
  const detailKey = ["task", "p", "t"] as const;
  const contextKey = ["task", "p", "t", "context"] as const;

  fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { ETag: ETAG },
    }),
  );
  const ctxBody = await conditionalFetch<{ ok: number }>({
    url: "/ctx",
    queryKey: contextKey,
    queryClient: qc,
  });
  qc.setQueryData(contextKey, ctxBody);

  fetchMock(
    new Response(JSON.stringify({ ok: 2 }), {
      status: 200,
      headers: { ETag: ETAG_NEXT },
    }),
  );
  const detailBody = await conditionalFetch<{ ok: number }>({
    url: "/detail",
    queryKey: detailKey,
    queryClient: qc,
  });
  qc.setQueryData(detailKey, detailBody);

  // Exact removal: evict ONLY detail (a plain `removeQueries` partial-matches
  // and would remove context too, masking the prefix-eviction bug).
  qc.removeQueries({ queryKey: detailKey, exact: true });

  // Context's validator must survive the detail eviction.
  const fn = fetchMock(new Response(null, { status: 304 }));
  await conditionalFetch({
    url: "/ctx",
    queryKey: contextKey,
    queryClient: qc,
  });

  const init = fn.mock.calls[0]![1] as RequestInit;
  expect(init.headers).toEqual({ "If-None-Match": ETAG });
});
