import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Side-channel `ETag` tracker keyed by a stable serialisation of the query
 * key. Storing the validator outside the cached body keeps the cache value
 * strictly typed as the resource itself — no `_etag` field leaking into
 * consumers. Lifecycle is bound to Query's own cache via
 * {@link bindToQueryCache}: when Query removes an entry (gcTime, manual
 * removal, etc.) the matching validator is dropped in lock-step. That
 * unification rules out the "side-channel outlives cache" failure mode
 * where a stale `If-None-Match` would coax a 304 with no body to return.
 */
const etagByKey = new Map<string, string>();

/**
 * Prefix for {@link conditionalFetchPage} per-page validators. Plain
 * {@link conditionalFetch} keys are `JSON.stringify(queryKey)` and always
 * start with `[`, so this namespace keeps page entries from colliding with —
 * or being prefix-matched against — a plain key that is a JSON prefix of a
 * longer sibling (e.g. `["task",p,t]` vs `["task",p,t,"context"]`).
 */
const PAGE_KEY_PREFIX = "page::";

/** QueryClients we've already attached the cache-removal subscriber to. */
const boundClients = new WeakSet<QueryClient>();

/** Reset the side-channel cache. Test-only — not exported publicly. */
export function _clearEtagCache(): void {
  etagByKey.clear();
}

/**
 * Subscribe to a {@link QueryClient}'s queryCache so that whenever a query
 * is removed from the cache (gc, manual removal, dehydration replace) the
 * matching `ETag` entry is dropped from the side-channel. Idempotent
 * per-client — the WeakSet ensures one subscription per QueryClient and
 * lets the QueryClient be garbage-collected normally.
 *
 * Also drops the per-page validators that {@link conditionalFetchPage}
 * stores under `${PAGE_KEY_PREFIX}[...queryKey, pageParam]`: an infinite query
 * keeps every page under one cache key, so when that key is removed every page
 * entry must go too. The page namespace confines this prefix sweep to page
 * entries — a plain sibling key that is a JSON prefix of the removed key
 * (e.g. removing `["task",p,t]` while `["task",p,t,"context"]` is still live)
 * is never matched.
 *
 * @param queryClient - QueryClient whose cache we should mirror.
 */
function bindToQueryCache(queryClient: QueryClient): void {
  if (boundClients.has(queryClient)) return;
  boundClients.add(queryClient);
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "removed") return;
    const removed = JSON.stringify(event.query.queryKey);
    etagByKey.delete(removed);
    const pagePrefix = `${PAGE_KEY_PREFIX}${removed.slice(0, -1)},`;
    for (const key of etagByKey.keys()) {
      if (key.startsWith(pagePrefix)) etagByKey.delete(key);
    }
  });
}

/** Arguments accepted by {@link conditionalFetch}. */
export interface ConditionalFetchArgs {
  /** Endpoint URL relative to the current origin. */
  url: string;
  /** Query key whose `ETag` validator we track. */
  queryKey: QueryKey;
  /** QueryClient used to read the previous cache value on 304. */
  queryClient: QueryClient;
  /** AbortSignal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/**
 * Issue a conditional GET.
 *
 * - Sends `If-None-Match` when the side-channel knows an `ETag` for this
 *   query key. ETag is byte-exact, sub-second, and unaffected by HTTP-date
 *   precision; it preserves freshness even when a mutation lands in the
 *   same wall-clock second as the previous read.
 * - `cache: 'no-store'` keeps the browser HTTP cache out of the conditional
 *   path so the side-channel is the single source of truth — without it
 *   the browser silently revalidates on its own and we'd see 304s for keys
 *   we never tracked.
 * - Lifecycle of the side-channel mirrors Query's cache via
 *   {@link bindToQueryCache}; entries clean up automatically when Query
 *   removes them.
 * - Defensive 304-with-no-cached-body fallback: in the rare microtask race
 *   where a fetch fires between Query removal and the cache subscriber's
 *   cleanup, drop the stale validator and refetch unconditionally so the
 *   queryFn never resolves to `undefined` (Query treats `undefined` as a
 *   queryFn failure).
 *
 * @param args - URL + query key bundle.
 * @returns Parsed JSON body. Always defined — never `undefined`.
 * @throws Error When the response status is not 200 or 304, or when the
 *   defensive follow-up fetch fails.
 */
export async function conditionalFetch<T>({
  url,
  queryKey,
  queryClient,
  signal,
}: ConditionalFetchArgs): Promise<T> {
  bindToQueryCache(queryClient);

  const keyStr = JSON.stringify(queryKey);
  const previous = etagByKey.get(keyStr);
  const headers: HeadersInit = previous ? { "If-None-Match": previous } : {};

  const res = await fetch(url, {
    headers,
    signal,
    credentials: "same-origin",
    cache: "no-store",
  });

  if (res.status === 304) {
    const cached = queryClient.getQueryData<T>(queryKey);
    if (cached !== undefined) return cached;
    etagByKey.delete(keyStr);
    const fresh = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!fresh.ok) {
      throw new Error(`${fresh.status} ${fresh.statusText}`);
    }
    const freshEtag = fresh.headers.get("ETag");
    if (freshEtag) etagByKey.set(keyStr, freshEtag);
    return (await fresh.json()) as T;
  }

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  const etag = res.headers.get("ETag");
  if (etag) etagByKey.set(keyStr, etag);
  return (await res.json()) as T;
}

/** Arguments accepted by {@link conditionalFetchPage}. */
export interface ConditionalFetchPageArgs {
  /** Endpoint URL including any cursor query param, relative to origin. */
  url: string;
  /** Base infinite-query key; pages share it and are addressed by `pageParam`. */
  queryKey: QueryKey;
  /** Param identifying this page (`null` for the first page). */
  pageParam: unknown;
  /** QueryClient used to read the cached page on 304. */
  queryClient: QueryClient;
  /** AbortSignal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/**
 * Conditional GET for one page of an infinite query. Mirrors
 * {@link conditionalFetch} but tracks the `ETag` per `(queryKey, pageParam)`
 * and resolves a 304 from the matching page inside the cached `InfiniteData`,
 * since an infinite query stores every page under one key.
 *
 * @param args - URL plus infinite-page bundle.
 * @returns Parsed page body. Always defined — never `undefined`.
 * @throws Error When the status is not 200 or 304, or the defensive refetch fails.
 */
export async function conditionalFetchPage<T>({
  url,
  queryKey,
  pageParam,
  queryClient,
  signal,
}: ConditionalFetchPageArgs): Promise<T> {
  bindToQueryCache(queryClient);

  const keyStr =
    PAGE_KEY_PREFIX +
    JSON.stringify([...(queryKey as readonly unknown[]), pageParam]);
  const previous = etagByKey.get(keyStr);
  const headers: HeadersInit = previous ? { "If-None-Match": previous } : {};

  const res = await fetch(url, {
    headers,
    signal,
    credentials: "same-origin",
    cache: "no-store",
  });

  if (res.status === 304) {
    const cached = readCachedPage<T>(queryClient, queryKey, pageParam);
    if (cached !== undefined) return cached;
    etagByKey.delete(keyStr);
    const fresh = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!fresh.ok) throw new Error(`${fresh.status} ${fresh.statusText}`);
    const freshEtag = fresh.headers.get("ETag");
    if (freshEtag) etagByKey.set(keyStr, freshEtag);
    return (await fresh.json()) as T;
  }

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const etag = res.headers.get("ETag");
  if (etag) etagByKey.set(keyStr, etag);
  return (await res.json()) as T;
}

/**
 * Read the cached page whose stored param matches `pageParam` out of an
 * infinite query's `InfiniteData`.
 *
 * @param queryClient - QueryClient holding the infinite cache.
 * @param queryKey - Base infinite-query key.
 * @param pageParam - Param identifying the page to read.
 * @returns The cached page, or `undefined` when absent.
 */
function readCachedPage<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  pageParam: unknown,
): T | undefined {
  const data = queryClient.getQueryData<{ pages: T[]; pageParams: unknown[] }>(
    queryKey,
  );
  if (!data) return undefined;
  const idx = data.pageParams.findIndex((p) => Object.is(p, pageParam));
  return idx >= 0 ? data.pages[idx] : undefined;
}
