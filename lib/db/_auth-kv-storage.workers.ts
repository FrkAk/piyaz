import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { SecondaryStorage } from "@better-auth/core/db";

/**
 * Minimal KV namespace surface used by the adapter. File-local stub so we
 * do not import `@cloudflare/workers-types` (banned by the project's
 * `no-restricted-imports` ESLint rule; see `worker-cf.ts:31-44`).
 */
interface KvNamespace {
  get(key: string, type: "text"): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/** `WorkerEnv` subset the adapter reads — only the `AUTH_KV` binding. */
interface WorkerEnv {
  AUTH_KV?: KvNamespace;
}

/** KV's documented minimum `expirationTtl`. Source: Cloudflare docs Jan 2026. */
const KV_TTL_FLOOR_SECONDS = 60;

/**
 * Per-isolate dedupe flag for the missing-binding warning. Resets when an
 * isolate cold-starts, so misconfigurations log once per isolate boot
 * (intended — quicker detection than a globally-once flag would give).
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
 * Lazily resolve the `AUTH_KV` binding on each adapter call.
 *
 * Module-load access to `getCloudflareContext` throws because no request
 * context exists at boot. Returns `null` when the binding is absent
 * (`wrangler dev` without `--env production`, scheduled handler bootstrap)
 * so adapter callers can no-op gracefully — matches the memory-fallback
 * pattern in `lib/api/rate-limit.ts:getBackend`.
 *
 * @returns The bound KV namespace, or `null` when unavailable.
 */
function getAuthKv(): KvNamespace | null {
  try {
    const env = getCloudflareContext({ async: false }).env as WorkerEnv;
    if (env.AUTH_KV) return env.AUTH_KV;
  } catch {
    // No active CF request context — fall through to the warning.
  }
  if (!_missingBindingWarned) {
    _missingBindingWarned = true;
    console.warn(
      JSON.stringify({
        event: "auth_kv_unavailable",
        hint: "AUTH_KV binding missing or called outside a request context; secondaryStorage will no-op.",
      }),
    );
  }
  return null;
}

/**
 * Build the Better Auth `secondaryStorage` adapter backed by Cloudflare KV.
 *
 * TTL handling on `set()`:
 *  - `ttl === undefined`: omit `expirationTtl` (KV keeps the entry until
 *    Better Auth issues an explicit `delete`).
 *  - `ttl <= 0`: no-op. BA's `refreshUserSessions`
 *    (`better-auth/db/internal-adapter.mjs:22-37`) can compute
 *    `getTTLSeconds = 0` for a session expiring inside the current second
 *    and pass that through to `set` without a positivity guard; without
 *    this branch the `Math.max(ttl, 60)` clamp would silently extend an
 *    expiring session for 60 more seconds in the cache.
 *  - `ttl > 0`: clamp up to KV's 60-second `expirationTtl` floor
 *    (better-auth#7124, better-auth#5452).
 *
 * `lib/auth.ts` MUST also set `session.cookieCache: { enabled: false }`
 * (better-auth#4203). Cookie cache + `secondaryStorage` forces re-login on
 * cookie expiry.
 *
 * `getAndDelete` is deliberately not implemented: KV has no atomic
 * primitive for it. To keep single-use verification consume
 * (OAuth authorization codes, magic links, etc.) safe across isolates,
 * `lib/auth.ts` sets `verification: { storeInDatabase: true }` so BA's
 * `consumeVerificationValue` routes through the DB-atomic
 * `runWithTransaction` + `consumeOne` path
 * (`better-auth/db/internal-adapter.mjs:671-697`) instead of the
 * per-isolate `withVerificationConsumeLock` fallback at line 651.
 *
 * KV operation failures are swallowed and logged (see `warnKvError`):
 * Drizzle is the source of truth and BA falls through to the DB on a
 * `get` returning `null`, so degrading to cache-miss on KV outage is
 * preferable to 500-ing auth-gated requests.
 *
 * @returns A `SecondaryStorage` adapter; calls no-op when `AUTH_KV` is unbound.
 */
export function getKvSecondaryStorage(): SecondaryStorage {
  return {
    async get(key) {
      const kv = getAuthKv();
      if (!kv) return null;
      try {
        return await kv.get(key, "text");
      } catch (err) {
        warnKvError("get", err);
        return null;
      }
    },
    async set(key, value, ttl) {
      const kv = getAuthKv();
      if (!kv) return;
      if (ttl === undefined) {
        try {
          await kv.put(key, value);
        } catch (err) {
          warnKvError("set", err);
        }
        return;
      }
      if (ttl <= 0) return;
      try {
        await kv.put(key, value, {
          expirationTtl: Math.max(ttl, KV_TTL_FLOOR_SECONDS),
        });
      } catch (err) {
        warnKvError("set", err);
      }
    },
    async delete(key) {
      const kv = getAuthKv();
      if (!kv) return;
      try {
        await kv.delete(key);
      } catch (err) {
        warnKvError("delete", err);
      }
    },
  };
}

/**
 * Emit a structured warning for a KV operation failure. Errors are
 * intentionally not rethrown: Drizzle is the source of truth, so a KV
 * outage degrades to a cache miss (`get`) or a stale entry held for the
 * existing ~60s propagation window (`set`/`delete`). Surfacing errors
 * instead would let a single-POP KV blip 500 auth-gated requests while
 * the DB is healthy.
 *
 * @param op - The adapter operation that failed (`get` / `set` / `delete`).
 * @param err - The underlying error thrown by the KV binding.
 */
function warnKvError(op: "get" | "set" | "delete", err: unknown): void {
  console.warn(
    JSON.stringify({
      event: "auth_kv_op_failed",
      op,
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}
