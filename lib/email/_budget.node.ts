import "server-only";

import type { EmailBudgetStore } from "./budget-types";

/** One counter window for a single budget key. */
interface Window {
  count: number;
  resetAt: number;
}

const _windows = new Map<string, Window>();

/**
 * Drop expired windows so a long-lived process does not accumulate one entry
 * per address seen. Runs on each read; the map only ever holds addresses
 * mailed inside the current window, which is bounded by the send rate.
 *
 * @param now - Current epoch milliseconds.
 */
function prune(now: number): void {
  for (const [key, window] of _windows) {
    if (window.resetAt <= now) _windows.delete(key);
  }
}

/**
 * Test-only: clear all counters so budget tests do not leak state into each
 * other. Not part of the runtime contract; never call from production code.
 */
export function __resetBudgetForTest(): void {
  _windows.clear();
}

/**
 * Node in-process email budget store.
 *
 * Self-host runs a single node, so an in-memory counter is exact here, by the
 * same reasoning that keeps server actions on `MemoryRateLimitBackend` in
 * `lib/api/rate-limit.ts`. Counters reset on restart, which is acceptable for
 * an abuse damper.
 *
 * @returns The in-memory store; never null on this runtime.
 */
export function getPlatformBudgetStore(): EmailBudgetStore | null {
  return {
    async read(key) {
      const now = Date.now();
      prune(now);
      const window = _windows.get(key);
      return window === undefined || window.resetAt <= now ? 0 : window.count;
    },
    async commit(key, used, windowSeconds) {
      const now = Date.now();
      const window = _windows.get(key);
      // A window that lapsed between the read and the commit starts fresh
      // rather than inheriting the stale deadline.
      const resetAt =
        window !== undefined && window.resetAt > now
          ? window.resetAt
          : now + windowSeconds * 1000;
      _windows.set(key, { count: used + 1, resetAt });
    },
  };
}
