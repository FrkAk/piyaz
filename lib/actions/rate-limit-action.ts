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
  /**
   * Backend slot to count against. Defaults to `"actions"` (per-isolate
   * memory on Workers; that slot is intentionally never bound to a CF
   * rate-limit binding because most actions declare tighter limits than
   * any binding could honor). A high-value secret-verification action
   * passes `"auth"` to get per-PoP durable enforcement on Workers — but
   * the binding enforces its own `simple.limit` (5/60) per key regardless
   * of the declared max, so EVERY limit routed here must equal 5/60 or
   * Workers silently enforces 5 while self-host enforces the declared
   * value. Self-host lazily builds a separate per-process memory backend
   * per slot, each enforcing declared limits exactly.
   */
  backendKind?: "actions" | "auth";
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
 * Map a backend check result to an action outcome.
 * @param result - Raw backend rate-limit result.
 * @returns `ok: true` when allowed, otherwise `retryAfter` seconds.
 */
function toOutcome(result: RateLimitResult): ActionRateLimitOutcome {
  return result.allowed
    ? { ok: true }
    : { ok: false, retryAfter: result.resetIn };
}

/**
 * Check (and count) only the per-IP limb of an action budget. Exposed
 * separately so the mutation wrappers can run it BEFORE the session
 * lookup — an unauthenticated flood is then counted and blocked without
 * farming a free DB session lookup per request.
 *
 * @param config - Rate-limit policy for this action.
 * @returns `ok: true` to proceed, otherwise `retryAfter` seconds.
 */
export async function checkActionIpRateLimit(
  config: ActionRateLimitConfig,
): Promise<ActionRateLimitOutcome> {
  const ip = await getActionClientIp();
  const result = await getBackend(config.backendKind ?? "actions").check(
    `action:${config.action}:ip:${ip}`,
    config.perIpMax,
    config.windowSeconds,
  );
  return toOutcome(result);
}

/**
 * Check (and count) only the per-user limb of an action budget.
 * @param config - Rate-limit policy for this action.
 * @param userId - Caller's user id.
 * @returns `ok: true` to proceed, otherwise `retryAfter` seconds.
 */
export async function checkActionUserRateLimit(
  config: ActionRateLimitConfig,
  userId: string,
): Promise<ActionRateLimitOutcome> {
  const result = await getBackend(config.backendKind ?? "actions").check(
    `action:${config.action}:user:${userId}`,
    config.perUserMax,
    config.windowSeconds,
  );
  return toOutcome(result);
}

/**
 * Apply two-key rate limiting (per-user AND per-IP) to a server action.
 * The first key to exceed its budget rejects the call; both buckets get
 * decremented on every successful pass. Counts against the slot named by
 * `config.backendKind` (default `"actions"`) from `lib/api/rate-limit.ts`.
 * The `"actions"` slot is intentionally never wired to a Cloudflare
 * rate-limit binding — most actions declare tighter `perUserMax`/`perIpMax`
 * values (3-30) than the API binding's 100/60 cap could honor, so the
 * per-isolate `MemoryRateLimitBackend` enforces them exactly instead of
 * being silently relaxed. Actions that opt into `"auth"` accept the
 * binding's 5/60 per-PoP enforcement deliberately (see `backendKind`).
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
  const checks: Promise<ActionRateLimitOutcome>[] = [
    checkActionIpRateLimit(config),
  ];
  if (userId) {
    checks.push(checkActionUserRateLimit(config, userId));
  }
  const results = await Promise.all(checks);
  return results.find((r) => !r.ok) ?? { ok: true };
}

/**
 * Thrown by the mutation wrappers (`lib/graph/mutations.ts`) when a caller
 * exceeds an action's budget. The wrappers already throw typed errors
 * (`ForbiddenError`, `ProjectNotFoundError`) that their callers catch, so
 * throwing here keeps the same contract instead of forcing every wrapper
 * to a discriminated-union return type.
 */
export class RateLimitError extends Error {
  /** @param retryAfter - Seconds until the caller may retry. */
  constructor(public readonly retryAfter: number) {
    super("Too many requests. Please slow down and try again shortly.");
    this.name = "RateLimitError";
  }
}
