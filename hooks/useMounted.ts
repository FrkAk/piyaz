"use client";

import { useSyncExternalStore } from "react";

/** No-op subscribe: the mount snapshot never changes after hydration. */
const subscribe = () => () => {};

/**
 * Detect the first client render. Returns `false` on the server and during
 * the hydration paint, then `true` once mounted on the client, without a
 * setState-in-effect. Use to defer viewport-dependent layout past hydration
 * so it never flashes an SSR-default layout.
 *
 * @returns `true` after the component has mounted on the client.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
