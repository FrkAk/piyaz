'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** No-op subscriber used on the server where `matchMedia` doesn't exist. */
const noopSubscribe = () => () => {};

/**
 * Track a CSS media query as boolean state. SSR returns the `defaultValue`
 * (defaults to `false`) and the real value lands on the first client paint.
 *
 * @param query - Standard CSS media query string (e.g. `(min-width: 1280px)`).
 * @param defaultValue - SSR fallback. Defaults to `false`.
 * @returns `true` when the query currently matches.
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  // `useSyncExternalStore` re-subscribes on identity change — memoise per `query`.
  const subscribe = useCallback(
    (callback: () => void) => {
      if (typeof window === 'undefined') return noopSubscribe();
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => (typeof window === 'undefined' ? defaultValue : window.matchMedia(query).matches),
    () => defaultValue,
  );
}
