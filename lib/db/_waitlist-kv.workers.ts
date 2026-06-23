import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Minimal KV namespace surface used by the waitlist writer. File-local
 * stub so we do not import `@cloudflare/workers-types` (banned by the
 * project's `no-restricted-imports` ESLint rule; see `worker-cf.ts:31-44`
 * and the matching stub in `_auth-kv-storage.workers.ts`).
 */
interface KvNamespace {
  put(key: string, value: string): Promise<void>;
}

/** `WorkerEnv` subset this writer reads — only the `WAITLIST_KV` binding. */
interface WorkerEnv {
  WAITLIST_KV?: KvNamespace;
}

/** Outcome of a waitlist write: stored, or the binding was unavailable. */
export type PutWaitlistResult = "stored" | "unavailable";

/**
 * Per-isolate dedupe flag for the missing-binding warning. Resets when an
 * isolate cold-starts, so misconfigurations log once per isolate boot
 * (intended — quicker detection than a globally-once flag would give).
 * Mirrors `_auth-kv-storage.workers.ts`.
 */
let _missingBindingWarned = false;

/**
 * Test-only: reset the warn-once flag so a test exercising the missing-
 * binding path can assert independently on the structured warn output.
 * Not part of the runtime contract; never call from production code.
 */
export function __resetMissingBindingWarnedForTest(): void {
  _missingBindingWarned = false;
}

/**
 * Lazily resolve the `WAITLIST_KV` binding on each call.
 *
 * Module-load access to `getCloudflareContext` throws because no request
 * context exists at boot. Returns `null` when the binding is absent
 * (self-host, `wrangler dev` without `--env production`) so the caller can
 * degrade gracefully — matches `getAuthKv` in `_auth-kv-storage.workers.ts`.
 *
 * @returns The bound KV namespace, or `null` when unavailable.
 */
function getWaitlistKv(): KvNamespace | null {
  try {
    const env = getCloudflareContext({ async: false }).env as WorkerEnv;
    if (env.WAITLIST_KV) return env.WAITLIST_KV;
  } catch {
    // No active CF request context — fall through to the warning.
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
 * The key is the **normalized email itself** (no prefix) so
 * `wrangler kv key list --binding WAITLIST_KV` yields a clean recipient
 * list. Dedupe is implicit: re-`put` overwrites the same key, no
 * read-before-write (KV is eventually consistent, so a read-check would be
 * racy; the latest timestamp wins, which is harmless for a waitlist). The
 * value is JSON `{ ts, source }` so the record stays extensible without a
 * schema migration.
 *
 * KV failures are swallowed and logged (Drizzle is the source of truth and
 * nothing downstream depends on this write succeeding synchronously); the
 * caller surfaces a generic failure. Returns `"unavailable"` when the
 * binding is missing so the action degrades gracefully on self-host/dev.
 *
 * @param email - Already-normalized (trimmed, lowercased) email address.
 * @returns `"stored"` on a successful (or swallowed-failure) write attempt,
 *   `"unavailable"` when no `WAITLIST_KV` binding is present.
 */
export async function putWaitlistEntry(
  email: string,
): Promise<PutWaitlistResult> {
  const kv = getWaitlistKv();
  if (!kv) return "unavailable";
  try {
    await kv.put(email, JSON.stringify({ ts: Date.now(), source: "signup-page" }));
  } catch (err) {
    warnKvError(err);
  }
  return "stored";
}

/**
 * Emit a structured warning for a failed waitlist KV write. The error is
 * intentionally not rethrown: a single-PoP KV blip should not 500 the
 * public sign-up page, and the capture is best-effort. Mirrors
 * `warnKvError` in `_auth-kv-storage.workers.ts`.
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
