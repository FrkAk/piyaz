import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { MemoryRateLimitBackend } from "./rate-limit-memory";

/**
 * Rate limit check result with quota info for IETF headers.
 */
export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetIn: number;
};

/**
 * A rate limit rule matching a URL pattern to limits and key strategy.
 *
 * `bindingKey` selects which Cloudflare rate-limit binding backs the rule on
 * the Workers deploy (`'api'` → `RATE_LIMIT_API`, `'auth'` → `RATE_LIMIT_AUTH`).
 * Omitted defaults to `'api'`. Self-host ignores this field — both kinds resolve
 * to the same in-memory backend by absence of bindings.
 *
 * Invariant: when a CF binding backs the slot, `max` and `window` MUST equal
 * the binding's `simple.limit` and `simple.period` declared in
 * `wrangler.jsonc:ratelimits[]`. The binding enforces only its own
 * `simple.limit` per composite key; `max` here only partitions counters and
 * fills the IETF `RateLimit-Policy` header. A mismatch makes the response
 * header advertise a limit the runtime does not enforce.
 */
export type RateLimitRule = {
  pattern: string;
  max: number;
  window: number;
  keyStrategy: "session" | "apikey";
  bindingKey?: "api" | "auth";
};

/**
 * Backend interface — both in-memory and CF Workers implement this.
 */
export interface RateLimitBackend {
  check(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

/**
 * Rate limit rules ordered most-specific first. `matchRule` returns the first
 * match, so paths with concrete prefixes (e.g. `/api/auth/sign-in`) must
 * precede the catch-all `/api/*`.
 *
 * Pre-auth IP keying on the two auth rules is intentional. CF docs discourage
 * IP-based keys for general user throttling because shared NATs cause
 * collateral throttling, but `sign-in` and `sign-up` have no session cookie
 * yet — IP is the only available key. Brute-force defense by IP is the
 * field-standard exception. Layered on top of Better-Auth's in-memory
 * `customRules` (`lib/auth.ts`) for defense-in-depth — BA tightens sign-up
 * to 3/60 in-process per isolate even though the CF binding only enforces
 * 5/60 here. Follow-up: declare a dedicated 3/60 binding to tighten the
 * middleware layer to match.
 */
export const RATE_LIMIT_RULES: RateLimitRule[] = [
  {
    pattern: "/api/auth/sign-in/*",
    max: 5,
    window: 60,
    keyStrategy: "session",
    bindingKey: "auth",
  },
  {
    pattern: "/api/auth/sign-up/*",
    max: 5,
    window: 60,
    keyStrategy: "session",
    bindingKey: "auth",
  },
  // Open unauthenticated DCR (`lib/auth.ts`): throttle on the strict `auth`
  // binding so anonymous callers cannot loop `oauthClient` inserts. The key is
  // pattern-namespaced, so this counter is independent of sign-in/sign-up.
  // Must precede `/api/*`; `max`/`window` mirror the auth binding per the
  // invariant above.
  {
    pattern: "/api/auth/oauth2/register",
    max: 5,
    window: 60,
    keyStrategy: "session",
    bindingKey: "auth",
  },
  { pattern: "/api/mcp", max: 100, window: 60, keyStrategy: "apikey" },
  { pattern: "/api/*", max: 100, window: 60, keyStrategy: "session" },
];

/** SSE path pattern — excluded from request rate limiting (single per-user
 * stream, throughput is broker-bound rather than request-rate-bound). */
const SSE_PATTERN = /^\/api\/events$/;

/**
 * Find the first matching rate limit rule for a pathname.
 * SSE paths are excluded (single long-lived stream per user).
 * @param pathname - URL pathname to match against rules.
 * @returns The first matching rule, or null if no match.
 */
export function matchRule(pathname: string): RateLimitRule | null {
  if (SSE_PATTERN.test(pathname)) return null;

  for (const rule of RATE_LIMIT_RULES) {
    if (rule.pattern.endsWith("/*")) {
      const prefix = rule.pattern.slice(0, -1);
      if (pathname.startsWith(prefix)) return rule;
    } else if (pathname === rule.pattern) {
      return rule;
    }
  }
  return null;
}

/**
 * Extract the rate limit key from a request based on the rule's key strategy.
 * API keys are SHA-256 hashed to avoid storing secrets in the rate limit map.
 * @param request - Incoming request.
 * @param strategy - Key extraction strategy (session or apikey).
 * @returns The extracted key string, or null if extraction fails.
 */
export async function extractKey(
  request: NextRequest,
  strategy: RateLimitRule["keyStrategy"],
): Promise<string | null> {
  switch (strategy) {
    case "session": {
      const cookie = getSessionCookie(request);
      return cookie ?? getClientIp(request);
    }
    case "apikey": {
      const auth = request.headers.get("authorization");
      if (auth?.startsWith("Bearer ")) return hashKey(auth.slice(7));
      return getClientIp(request);
    }
  }
}

/**
 * SHA-256 hash a string to a hex digest.
 * @param value - The string to hash.
 * @returns Hex-encoded hash.
 */
async function hashKey(value: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract client IP from request headers.
 * @param request - Incoming request.
 * @returns Client IP address or "unknown".
 */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Build IETF RateLimit response headers (draft v10).
 * @param result - Rate limit check result.
 * @param rule - The matched rate limit rule.
 * @returns Header name-value map including RateLimit-Policy, RateLimit, and Retry-After (when blocked).
 */
export function rateLimitHeaders(
  result: RateLimitResult,
  rule: RateLimitRule,
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Policy": `${rule.max};w=${rule.window}`,
    RateLimit: `limit=${result.limit}, remaining=${result.remaining}, reset=${result.resetIn}`,
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(result.resetIn);
  }
  return headers;
}

type BackendKind = "api" | "auth" | "actions";

/**
 * Backend slot table keyed by kind. `worker-cf.ts` wires `api` and `auth` to
 * the matching Cloudflare bindings on first request; `actions` is
 * intentionally never bound (server actions declare tighter `max` values
 * than any single CF binding can enforce, so they stay on the per-isolate
 * `MemoryRateLimitBackend` where rule limits are honored exactly).
 */
const _backends: Record<BackendKind, RateLimitBackend | null> = {
  api: null,
  auth: null,
  actions: null,
};

const MAX_WINDOW_MS = Math.max(...RATE_LIMIT_RULES.map((r) => r.window)) * 1000;

/**
 * Get the rate limit backend for the given kind. Lazy-init to
 * `MemoryRateLimitBackend` on first read if no `setBackend` has run for that
 * kind — preserves self-host behavior where neither CF binding exists.
 *
 * @param kind - Which binding slot to read; defaults to `'api'`.
 * @returns The active rate limit backend for the slot.
 */
export function getBackend(kind: BackendKind = "api"): RateLimitBackend {
  if (!_backends[kind])
    _backends[kind] = new MemoryRateLimitBackend(MAX_WINDOW_MS);
  return _backends[kind];
}

/**
 * Override the rate limit backend for a specific kind. Called once per isolate
 * from `worker-cf.ts` on first request to register the Cloudflare rate-limit
 * binding-backed implementation. Self-host never calls this; the lazy memory
 * backend in `getBackend` covers that path.
 *
 * @param kind - Binding slot to write (`'api'` or `'auth'`).
 * @param backend - The backend instance to register for that slot.
 */
export function setBackend(kind: BackendKind, backend: RateLimitBackend): void {
  _backends[kind] = backend;
}
