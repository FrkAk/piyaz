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

let _missingBindingWarned = false;

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
 * `set()` clamps TTLs below KV's 60-second `expirationTtl` floor with
 * `Math.max(ttl, 60)` (better-auth#7124, better-auth#5452). `set()` with
 * no TTL omits `expirationTtl` so KV keeps the entry until Better Auth
 * issues a `delete` (the BA session-create call site at
 * `node_modules/better-auth/dist/db/internal-adapter.mjs:33` passes no TTL).
 *
 * `lib/auth.ts` MUST also set `session.cookieCache: { enabled: false }`
 * (better-auth#4203). Cookie cache + `secondaryStorage` forces re-login on
 * cookie expiry.
 *
 * `getAndDelete` is deliberately not implemented: KV has no atomic
 * primitive for it, and emulating as get-then-delete loses the race
 * property BA wants. BA has a documented fallback path when
 * `getAndDelete` is absent.
 *
 * @returns A `SecondaryStorage` adapter; calls no-op when `AUTH_KV` is unbound.
 */
export function getKvSecondaryStorage(): SecondaryStorage {
  return {
    async get(key) {
      const kv = getAuthKv();
      if (!kv) return null;
      return kv.get(key, "text");
    },
    async set(key, value, ttl) {
      const kv = getAuthKv();
      if (!kv) return;
      if (ttl === undefined) {
        await kv.put(key, value);
        return;
      }
      await kv.put(key, value, {
        expirationTtl: Math.max(ttl, KV_TTL_FLOOR_SECONDS),
      });
    },
    async delete(key) {
      const kv = getAuthKv();
      if (!kv) return;
      await kv.delete(key);
    },
  };
}
