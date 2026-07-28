import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { EmailBudgetStore } from "./budget-types";

/**
 * Minimal KV surface this store uses. File-local stub because
 * `@cloudflare/workers-types` is banned by the `no-restricted-imports` ESLint
 * rule; mirrors `lib/db/_auth-kv-storage.workers.ts`.
 */
interface KvNamespace {
  get(key: string, options: { type: "text" }): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/** The `WorkerEnv` subset this store reads: only the `AUTH_KV` binding. */
interface WorkerEnv {
  AUTH_KV?: KvNamespace;
}

/** KV's documented minimum `expirationTtl`. Source: Cloudflare docs Jan 2026. */
const KV_TTL_FLOOR_SECONDS = 60;

/**
 * Per-isolate dedupe flag for the missing-binding warning. Resets when an
 * isolate cold-starts, so misconfigurations log once per isolate boot.
 */
let _missingBindingWarned = false;

/**
 * Test-only: reset the warn-once flag so a test exercising the missing-binding
 * path can assert independently. Never call from production code.
 */
export function __resetMissingBindingWarnedForTest(): void {
  _missingBindingWarned = false;
}

/**
 * Resolve the `AUTH_KV` binding per call; module-load access to
 * `getCloudflareContext` throws because no request context exists at boot.
 *
 * @returns The bound KV namespace, or `null` when unavailable.
 */
function getAuthKv(): KvNamespace | null {
  try {
    const env = getCloudflareContext({ async: false }).env as WorkerEnv;
    if (env.AUTH_KV) return env.AUTH_KV;
  } catch {
    // No active CF request context; fall through to the warning.
  }
  if (!_missingBindingWarned) {
    _missingBindingWarned = true;
    console.warn(
      JSON.stringify({
        event: "email_budget_kv_unavailable",
        hint: "AUTH_KV binding missing or called outside a request context; the per-recipient email budget will not be enforced.",
      }),
    );
  }
  return null;
}

/**
 * Cloudflare KV-backed email budget store.
 *
 * Consistency caveat, in the same spirit as the session-cache note in
 * `lib/auth.ts`: KV read-modify-write is not atomic and writes propagate
 * globally in roughly 60 seconds, so a caller spread across POPs can exceed
 * the nominal budget. This is an abuse damper, not a hard boundary: it turns
 * an unbounded flood into a bounded trickle. Exact per-address enforcement
 * would need a Durable Object round trip on every auth email, which is not
 * worth the latency for this threat.
 *
 * Fails open on KV error: a KV outage must degrade to "email still sends",
 * never to "nobody can verify their address".
 *
 * @returns The KV-backed store, or `null` when `AUTH_KV` is unbound.
 */
export function getPlatformBudgetStore(): EmailBudgetStore | null {
  const kv = getAuthKv();
  if (kv === null) return null;
  return {
    async read(key) {
      try {
        const raw = await kv.get(key, { type: "text" });
        const count = raw === null ? 0 : Number.parseInt(raw, 10);
        return Number.isFinite(count) && count > 0 ? count : 0;
      } catch (err) {
        logKvFailure(err);
        // Fail open: an unreadable counter reports no usage, so the send goes.
        return 0;
      }
    },
    async commit(key, used, windowSeconds) {
      try {
        await kv.put(key, String(used + 1), {
          expirationTtl: Math.max(windowSeconds, KV_TTL_FLOOR_SECONDS),
        });
      } catch (err) {
        // A lost increment undercounts, which errs toward delivering mail.
        // Concurrent sends to one address across POPs also land here: KV
        // allows one write per second per key and rejects the rest with 429.
        logKvFailure(err);
      }
    },
  };
}

/**
 * Record a KV fault without the recipient key, which is a digest of an address.
 *
 * @param err - The thrown value.
 */
function logKvFailure(err: unknown): void {
  console.warn(
    JSON.stringify({
      event: "email_budget_kv_op_failed",
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}
