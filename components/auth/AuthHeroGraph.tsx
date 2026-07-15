"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";

const LG_QUERY = "(min-width: 1024px)";

const AuthHeroGraphCanvas = dynamic(
  () =>
    import("@/components/auth/AuthHeroGraphCanvas").then(
      (m) => m.AuthHeroGraphCanvas,
    ),
  { ssr: false },
);

/**
 * Subscribe to `lg` breakpoint changes.
 *
 * @param onChange - Store change callback.
 * @returns Unsubscribe function.
 */
function subscribeLg(onChange: () => void): () => void {
  const mql = window.matchMedia(LG_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * Breakpoint gate for the auth-hero graph. The hero column is `hidden`
 * below `lg`, so this defers the d3-force canvas chunk (and its render
 * loop) until the viewport can actually show it; on the server and on
 * small viewports it renders nothing.
 *
 * @returns The lazy graph canvas at `lg+`, otherwise null.
 */
export function AuthHeroGraph() {
  const isLg = useSyncExternalStore(
    subscribeLg,
    () => window.matchMedia(LG_QUERY).matches,
    () => false,
  );
  if (!isLg) return null;
  return <AuthHeroGraphCanvas />;
}
