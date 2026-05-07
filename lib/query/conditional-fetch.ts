import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Side-channel `Last-Modified` tracker keyed by a stable serialisation of
 * the query key. Storing the validator outside the cached body keeps the
 * cache value strictly typed as the resource itself — no `_lastModified`
 * field leaking into consumers. Lifecycle is bound to Query's own cache
 * via {@link bindToQueryCache}: when Query removes an entry (gcTime, manual
 * removal, etc.) the matching validator is dropped in lock-step. That
 * unification rules out the "side-channel outlives cache" failure mode
 * where a stale `If-Modified-Since` would coax a 304 with no body to
 * return.
 */
const lastModifiedByKey = new Map<string, string>();

/** QueryClients we've already attached the cache-removal subscriber to. */
const boundClients = new WeakSet<QueryClient>();

/** Reset the side-channel cache. Test-only — not exported publicly. */
export function _clearLastModifiedCache(): void {
  lastModifiedByKey.clear();
}

/**
 * Subscribe to a {@link QueryClient}'s queryCache so that whenever a query
 * is removed from the cache (gc, manual removal, dehydration replace) the
 * matching `Last-Modified` entry is dropped from the side-channel. Idempotent
 * per-client — the WeakSet ensures one subscription per QueryClient and lets
 * the QueryClient be garbage-collected normally.
 *
 * @param queryClient - QueryClient whose cache we should mirror.
 */
function bindToQueryCache(queryClient: QueryClient): void {
  if (boundClients.has(queryClient)) return;
  boundClients.add(queryClient);
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "removed") {
      lastModifiedByKey.delete(JSON.stringify(event.query.queryKey));
    }
  });
}

/** Arguments accepted by {@link conditionalFetch}. */
export interface ConditionalFetchArgs {
  /** Endpoint URL relative to the current origin. */
  url: string;
  /** Query key whose `Last-Modified` validator we track. */
  queryKey: QueryKey;
  /** QueryClient used to read the previous cache value on 304. */
  queryClient: QueryClient;
  /** AbortSignal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/**
 * Issue a conditional GET.
 *
 * - Sends `If-Modified-Since` when the side-channel knows a `Last-Modified`
 *   for this query key.
 * - `cache: 'no-store'` keeps the browser HTTP cache out of the conditional
 *   path so the side-channel is the single source of truth — without it the
 *   browser silently revalidates on its own and we'd see 304s for keys we
 *   never tracked.
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
  const previous = lastModifiedByKey.get(keyStr);
  const headers: HeadersInit = previous
    ? { "If-Modified-Since": previous }
    : {};

  const res = await fetch(url, {
    headers,
    signal,
    credentials: "same-origin",
    cache: "no-store",
  });

  if (res.status === 304) {
    const cached = queryClient.getQueryData<T>(queryKey);
    if (cached !== undefined) return cached;
    lastModifiedByKey.delete(keyStr);
    const fresh = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!fresh.ok) {
      throw new Error(`${fresh.status} ${fresh.statusText}`);
    }
    const freshLm = fresh.headers.get("Last-Modified");
    if (freshLm) lastModifiedByKey.set(keyStr, freshLm);
    return (await fresh.json()) as T;
  }

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }

  const lm = res.headers.get("Last-Modified");
  if (lm) lastModifiedByKey.set(keyStr, lm);
  return (await res.json()) as T;
}
