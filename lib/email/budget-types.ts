/**
 * Storage contract for the per-recipient email budget. Zero runtime imports
 * and no side effects, so it compiles identically into the Node and Workers
 * bundles, same rationale as `lib/email/types.ts`.
 */

/**
 * A counter store backing the per-recipient send budget.
 *
 * Split into a read and a commit so the budget counts *delivered* mail. A
 * store that counted at the check would let three provider failures exhaust a
 * recipient's hourly allowance and lock a real user out of verification. The
 * split also keeps the operation count flat: `read` observes the count and
 * `commit` writes the successor it implies, so a KV-backed store still does
 * one read and one write per send.
 */
export interface EmailBudgetStore {
  /**
   * Sends already counted for `key` in the current window.
   *
   * Fails open by reporting `0`: a counter outage must never stop a user
   * verifying their address.
   *
   * @param key - Opaque budget key (already hashed by the caller).
   * @returns The count so far, or `0` when unknown.
   */
  read(key: string): Promise<number>;

  /**
   * Record one delivered send against `key`.
   *
   * @param key - Opaque budget key (already hashed by the caller).
   * @param used - Count observed by the matching {@link EmailBudgetStore.read}.
   * @param windowSeconds - Window length in seconds.
   */
  commit(key: string, used: number, windowSeconds: number): Promise<void>;
}
