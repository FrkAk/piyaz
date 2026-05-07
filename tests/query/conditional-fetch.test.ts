import { test, expect, beforeEach, mock } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  _clearLastModifiedCache,
  conditionalFetch,
} from "@/lib/query/conditional-fetch";

beforeEach(() => {
  _clearLastModifiedCache();
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

test("200 stores Last-Modified and returns parsed body", async () => {
  const lm = new Date("2026-05-07T10:00:00Z").toUTCString();
  const fn = fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { "Last-Modified": lm, "Content-Type": "application/json" },
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

test("subsequent request sends If-Modified-Since with stored value", async () => {
  const lm = new Date("2026-05-07T10:00:00Z").toUTCString();
  const qc = new QueryClient();

  fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { "Last-Modified": lm },
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
    "If-Modified-Since": lm,
  });
});

test("304 with no Query cache refetches unconditionally and returns body", async () => {
  // Simulate the real-world failure mode: side-channel still has a
  // Last-Modified, but Query has gc'd (or never had) the cached body. The
  // helper must not return undefined — it should drop the validator and
  // reissue the request to land a defined value.
  const lm = new Date("2026-05-07T10:00:00Z").toUTCString();
  const qc = new QueryClient();

  // Seed the side-channel by completing one full 200 fetch.
  fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { "Last-Modified": lm },
    }),
  );
  await conditionalFetch({ url: "/api/x", queryKey: ["x"], queryClient: qc });
  // Drop Query's cache so the conditional path can't satisfy from there.
  qc.removeQueries({ queryKey: ["x"] });

  const responses: Response[] = [
    new Response(null, { status: 304 }),
    new Response(JSON.stringify({ ok: 2 }), {
      status: 200,
      headers: { "Last-Modified": lm },
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

test("side-channel drops Last-Modified when Query removes the entry", async () => {
  // Root-cause guard for the 'side-channel outlives Query gcTime' failure
  // mode. After Query evicts a cache entry the matching validator must be
  // gone too, so the next fetch sends no `If-Modified-Since` and the server
  // can't 304 us into the no-cache trap.
  const lm = new Date("2026-05-07T10:00:00Z").toUTCString();
  const qc = new QueryClient();

  fetchMock(
    new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { "Last-Modified": lm },
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
      headers: { "Last-Modified": lm },
    }),
  );
  await conditionalFetch({ url: "/api/x", queryKey: ["x"], queryClient: qc });

  const init = fn.mock.calls[0]![1] as RequestInit;
  expect(init.headers).toEqual({});
});
