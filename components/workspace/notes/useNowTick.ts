"use client";

import { useEffect, useState } from "react";

/**
 * Epoch milliseconds refreshed every minute, so relative-time tags on a
 * quietly open panel never go stale between renders.
 *
 * @returns The latest clock reading.
 */
export function useNowTick(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  return nowMs;
}
