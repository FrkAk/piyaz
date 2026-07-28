/**
 * Storage contract for the per-recipient email budget. Zero runtime imports
 * and no side effects, so it compiles identically into the Node and Workers
 * bundles, same rationale as `lib/email/types.ts`.
 */

/**
 * A counter store backing the per-recipient send budget.
 */
export interface EmailBudgetStore {
  /**
   * Count one send against `key` and report whether it fits the budget.
   *
   * @param key - Opaque budget key (already hashed by the caller).
   * @param max - Sends allowed per window.
   * @param windowSeconds - Window length in seconds.
   * @returns `true` when the send is within budget, `false` when it should be dropped.
   */
  consume(key: string, max: number, windowSeconds: number): Promise<boolean>;
}
