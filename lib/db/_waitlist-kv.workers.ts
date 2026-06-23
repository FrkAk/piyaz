import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Minimal KV surface used by the waitlist writer. File-local stub because
 * `@cloudflare/workers-types` is banned by the `no-restricted-imports`
 * ESLint rule.
 */
interface KvNamespace {
  put(key: string, value: string): Promise<void>;
}

/** The `WorkerEnv` subset this writer reads: only the `WAITLIST_KV` binding. */
interface WorkerEnv {
  WAITLIST_KV?: KvNamespace;
}

/** Outcome of a waitlist write: stored, or the binding was unavailable. */
export type PutWaitlistResult = "stored" | "unavailable";

/**
 * Per-isolate dedupe flag for the missing-binding warning. Resets on
 * isolate cold-start, so a misconfiguration logs once per isolate boot.
 */
let _missingBindingWarned = false;

/**
 * Test-only: reset the warn-once flag between tests. Not part of the
 * runtime contract; never call from production code.
 */
export function __resetMissingBindingWarnedForTest(): void {
  _missingBindingWarned = false;
}

/**
 * Resolve the `WAITLIST_KV` binding per call; module-load access to
 * `getCloudflareContext` throws because there is no request context at
 * boot. Returns `null` when the binding is absent (self-host, dev) so the
 * caller can degrade gracefully.
 *
 * @returns The bound KV namespace, or `null` when unavailable.
 */
function getWaitlistKv(): KvNamespace | null {
  try {
    const env = getCloudflareContext({ async: false }).env as WorkerEnv;
    if (env.WAITLIST_KV) return env.WAITLIST_KV;
  } catch {
    // No active CF request context; fall through to the warning.
  }
  if (!_missingBindingWarned) {
    _missingBindingWarned = true;
    console.warn(
      JSON.stringify({
        event: "waitlist_kv_unavailable",
        hint: "WAITLIST_KV binding missing or called outside a request context; waitlist capture will no-op.",
      }),
    );
  }
  return null;
}

/**
 * Store a normalized email on the waitlist.
 *
 * The key is the email itself (no prefix) so
 * `wrangler kv key list --binding WAITLIST_KV` yields a clean recipient
 * list; a re-`put` overwrites, giving implicit dedupe. The value is JSON
 * `{ ts, source }`. KV failures are swallowed and logged (best-effort
 * capture); a missing binding returns `"unavailable"` so the action
 * degrades on self-host/dev.
 *
 * @param email - Already-normalized (trimmed, lowercased) email address.
 * @returns `"stored"` on a write attempt (including a swallowed failure),
 *   `"unavailable"` when no `WAITLIST_KV` binding is present.
 */
export async function putWaitlistEntry(
  email: string,
): Promise<PutWaitlistResult> {
  const kv = getWaitlistKv();
  if (!kv) return "unavailable";
  try {
    await kv.put(
      email,
      JSON.stringify({ ts: Date.now(), source: "signup-page" }),
    );
  } catch (err) {
    warnKvError(err);
  }
  return "stored";
}

/**
 * Log a structured warning for a failed waitlist KV write. Not rethrown:
 * the capture is best-effort.
 *
 * @param err - The underlying error thrown by the KV binding.
 */
function warnKvError(err: unknown): void {
  console.warn(
    JSON.stringify({
      event: "waitlist_kv_put_failed",
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}
