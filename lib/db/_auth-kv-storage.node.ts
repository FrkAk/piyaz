import "server-only";
import type { SecondaryStorage } from "@better-auth/core/db";

/**
 * Self-host `secondaryStorage` factory.
 *
 * Returns `undefined` so Better Auth runs without a secondary cache; the
 * Drizzle DB adapter remains the source of truth for session reads on
 * self-host. The Workers sibling at `_auth-kv-storage.workers.ts`
 * returns a KV-backed adapter — both share this signature so
 * `lib/auth.ts` is runtime-agnostic.
 *
 * @returns Always `undefined` on the Node runtime.
 */
export function getKvSecondaryStorage(): SecondaryStorage | undefined {
  return undefined;
}
