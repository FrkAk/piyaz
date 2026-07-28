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
 * per address seen. Runs on each consume; the map only ever holds addresses
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
    async consume(key, max, windowSeconds) {
      const now = Date.now();
      prune(now);
      const existing = _windows.get(key);
      if (existing === undefined || existing.resetAt <= now) {
        _windows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
        return true;
      }
      if (existing.count >= max) return false;
      existing.count += 1;
      return true;
    },
  };
}
