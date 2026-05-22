import "server-only";

import { headers } from "next/headers";
import { getBackend, type RateLimitResult } from "@/lib/api/rate-limit";

/**
 * Per-key throttle config for a server action. The action consults two
 * keys (per-user, per-IP) and rejects when either exceeds its budget;
 * unauth callers fall back to IP-only. Defense in depth on top of code
 * entropy — never the first line of defense.
 */
export type ActionRateLimitConfig = {
  /** Stable identifier for the action; namespaces the rate-limit keys. */
  action: string;
  /** Window in seconds. */
  windowSeconds: number;
  /** Per-user budget within the window. */
  perUserMax: number;
  /** Per-IP budget within the window. */
  perIpMax: number;
};

/**
 * Outcome of a rate-limit check. `retryAfter` is in seconds and only set
 * when `ok` is false. Callers map this to the typed `rate_limited`
 * failure code in their result type.
 */
export type ActionRateLimitOutcome =
  | { ok: true }
  | { ok: false; retryAfter: number };

/**
 * Pull the client IP from request headers in a server action. Mirrors
 * the order in `lib/auth.ts:advanced.ipAddress.ipAddressHeaders` so a
 * single proxy chain controls both BA and our action limiter. Falls
 * back to `"unknown"` so two unattributable callers share one bucket.
 *
 * @returns Client IP string or `"unknown"`.
 */
async function getActionClientIp(): Promise<string> {
  const reqHeaders = await headers();
  const forwarded = reqHeaders.get("x-forwarded-for");
  return (
    reqHeaders.get("cf-connecting-ip") ??
    forwarded?.split(",")[0]?.trim() ??
    reqHeaders.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Apply two-key rate limiting (per-user AND per-IP) to a server action.
 * The first key to exceed its budget rejects the call; both buckets get
 * decremented on every successful pass. Uses the dedicated `"actions"`
 * backend slot from `lib/api/rate-limit.ts`, which is intentionally never
 * wired to a Cloudflare rate-limit binding — actions declare tighter
 * `perUserMax`/`perIpMax` values (3-30) than the API binding's 100/60 cap
 * could honor, so the per-isolate `MemoryRateLimitBackend` enforces them
 * exactly instead of being silently relaxed to the binding limit.
 *
 * Both buckets are consulted (and incremented) atomically — when only
 * one rejects, the other has already counted the attempt. That tightens
 * the surviving bucket slightly under sustained overload, which is the
 * intended behavior: a caller who keeps hammering is throttled by both
 * dimensions, not just the one that tripped first.
 *
 * @param config - Rate-limit policy for this action.
 * @param userId - Caller's user id, or `null` for unauth flows.
 * @returns `ok: true` to proceed, otherwise `retryAfter` seconds.
 */
export async function checkActionRateLimit(
  config: ActionRateLimitConfig,
  userId: string | null,
): Promise<ActionRateLimitOutcome> {
  const backend = getBackend("actions");
  const ip = await getActionClientIp();

  const checks: Promise<RateLimitResult>[] = [
    backend.check(
      `action:${config.action}:ip:${ip}`,
      config.perIpMax,
      config.windowSeconds,
    ),
  ];
  if (userId) {
    checks.push(
      backend.check(
        `action:${config.action}:user:${userId}`,
        config.perUserMax,
        config.windowSeconds,
      ),
    );
  }

  const results = await Promise.all(checks);
  const blocked = results.find((r) => !r.allowed);
  if (blocked) {
    return { ok: false, retryAfter: blocked.resetIn };
  }
  return { ok: true };
}
