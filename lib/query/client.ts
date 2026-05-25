import { cache } from "react";
import { QueryClient } from "@tanstack/react-query";

/**
 * Build a QueryClient with the project-wide defaults. Used both server-side
 * (per-request via {@link getServerQueryClient}) and client-side (lazy
 * singleton via {@link getBrowserQueryClient}).
 *
 * @returns Configured QueryClient instance.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: 1,
      },
    },
  });
}

/**
 * Server-side per-request QueryClient. React `cache()` scopes the instance
 * to the current request so different requests don't share dehydrated state.
 *
 * @returns QueryClient unique to the current React server render.
 */
export const getServerQueryClient = cache(makeQueryClient);

type BrowserGlobals = typeof globalThis & {
  __mymirQueryClient?: QueryClient;
};

/**
 * Browser-side QueryClient singleton. Stored on `globalThis` so HMR and
 * stacked client-component re-renders share the same cache.
 *
 * @returns Singleton QueryClient for the current browser tab.
 */
export function getBrowserQueryClient(): QueryClient {
  const g = globalThis as BrowserGlobals;
  if (!g.__mymirQueryClient) g.__mymirQueryClient = makeQueryClient();
  return g.__mymirQueryClient;
}
