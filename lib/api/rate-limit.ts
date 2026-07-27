import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { clientIpKey, resolveClientIp } from "@/lib/security/client-ip";
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
 * the Workers deploy (`'api'` → `RATE_LIMIT_API`, `'auth'` → `RATE_LIMIT_AUTH`,
 * `'mcp'` → `RATE_LIMIT_MCP`, `'mcpHeavy'` → `RATE_LIMIT_MCP_HEAVY`).
 * Omitted defaults to `'api'`. Self-host ignores this field — every kind
 * resolves to an in-memory backend by absence of bindings.
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
  keyStrategy: "session" | "apikey" | "ip";
  bindingKey?: "api" | "auth" | "mcp" | "mcpHeavy";
  /**
   * Also count the request against a second bucket keyed on the client
   * address, when one can be trusted. Set on rules whose primary key is
   * caller-supplied, so rotating that value cannot escape the budget. Skipped
   * when no address resolves, which keeps a deployment with no declared proxy
   * from collapsing every caller into one bucket.
   */
  addressCeiling?: boolean;
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
 * The pre-auth `auth` rules use the `"ip"` key strategy, NOT `"session"`.
 * These endpoints are reached by unauthenticated callers, so any session
 * cookie on the request is either absent or attacker-supplied:
 * `getSessionCookie` returns the raw cookie value with no signature/DB
 * validation, so a `"session"` key would let a caller mint a fresh rate-limit
 * bucket per request by rotating a forged cookie and bypass the limit
 * entirely. Every unauthenticated endpoint whose cost lands somewhere else
 * (an email to a victim's inbox, an `oauthClient` row, a token-grant attempt,
 * a deleted account) belongs on this list rather than on the catch-all, which
 * is why `request-password-reset`, `send-verification-email`,
 * `reset-password`, `delete-user/callback` and `oauth2/token` are enumerated
 * here.
 *
 * The test an endpoint has to fail to earn a rule is whether an anonymous
 * caller can reach it and make it cost something. The rest of the allowlist in
 * `app/api/auth/[...all]/route.ts` passes that test: `/oauth2/authorize`,
 * `/consent` and `/continue` need a session, `/oauth2/revoke` and
 * `/introspect` need client credentials, `/oauth2/userinfo` needs a bearer
 * token, and `/get-session` and `/jwks` read cached state without writing.
 * Those stay on the catch-all with its address ceiling.
 *
 * Keying on the client IP (resolved by
 * `lib/security/client-ip.ts`, which trusts a header only where something
 * upstream sets it) is the only un-forgeable identifier available. CF docs
 * discourage IP keys for general user throttling because shared NATs cause
 * collateral throttling, but brute-force / registration-flood defense by IP is
 * the field-standard exception. Layered on top of Better-Auth's in-memory
 * `customRules` (`lib/auth.ts`) for defense-in-depth — BA tightens sign-up
 * to 3/60 in-process per isolate even though the CF binding only enforces
 * 5/60 here. Follow-up: declare a dedicated 3/60 binding to tighten the
 * middleware layer to match.
 *
 * The `/oauth2/register` rule throttles open unauthenticated dynamic client
 * registration (`lib/auth.ts`) on the strict `auth` binding so anonymous
 * callers cannot loop `oauthClient` inserts. The key is pattern-namespaced,
 * keeping its counter independent of sign-in/sign-up; `max`/`window` mirror
 * the auth binding per the invariant above.
 */
export const RATE_LIMIT_RULES: RateLimitRule[] = [
  {
    pattern: "/api/auth/sign-in/*",
    max: 5,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "auth",
  },
  {
    pattern: "/api/auth/sign-up/*",
    max: 5,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "auth",
  },
  {
    pattern: "/api/auth/oauth2/register",
    max: 5,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "auth",
  },
  {
    pattern: "/api/auth/request-password-reset",
    max: 5,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "auth",
  },
  {
    pattern: "/api/auth/send-verification-email",
    max: 5,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "auth",
  },
  {
    pattern: "/api/auth/reset-password",
    max: 5,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "auth",
  },
  {
    // Link-consumption paths, matched by prefix because the token rides in the
    // path segment (better-auth's GET `/reset-password/:token`) and would
    // otherwise miss the exact-match rule above and land on the catch-all.
    // They consume a high-entropy token rather than guessing a credential, and
    // a user follows them from their inbox, so the general budget is right:
    // the brute-force one is shared instance-wide wherever no address
    // resolves, which would block legitimate resets and verifications.
    pattern: "/api/auth/reset-password/*",
    max: 100,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "api",
  },
  {
    pattern: "/api/auth/verify-email",
    max: 100,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "api",
  },
  {
    // Same shape as the two above: a GET the user follows from their inbox,
    // carrying a high-entropy token rather than a guessable credential. It
    // deletes the account, so it does not belong on the catch-all's forgeable
    // cookie key, and it does not belong on the brute-force budget either.
    pattern: "/api/auth/delete-user/callback",
    max: 100,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "api",
  },
  {
    // Machine traffic, not a credential-guessing surface: every MCP client
    // refreshes here once its access token expires, and `accessTokenExpiresIn`
    // is 1h. The brute-force budget the rules above use would throttle a
    // normal fleet, and hardest where an address cannot be resolved and every
    // caller shares one bucket. What this rule is for is getting the endpoint
    // off the catch-all's forgeable session-cookie key, which the `ip`
    // strategy does at the general API budget.
    pattern: "/api/auth/oauth2/token",
    max: 100,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "api",
  },
  {
    pattern: "/api/mcp",
    max: 100,
    window: 60,
    keyStrategy: "apikey",
    bindingKey: "mcp",
    // The bearer token is the caller's own bytes and is not verified until the
    // route handler runs, so the token bucket alone bounds nothing: a fresh
    // random token is a fresh counter. The address ceiling is what an
    // unauthenticated flood actually runs into.
    addressCeiling: true,
  },
  // The session key gives a signed-in caller its own bucket, which is the
  // fairness property worth having, but nothing has verified that cookie yet,
  // so a caller willing to rotate one would otherwise mint buckets without
  // limit. The address ceiling is what actually bounds that: a forged cookie
  // buys a fresh counter, never a fresh address. Where no address resolves the
  // ceiling is skipped and only the enumerated `"ip"` rules above still bind,
  // which is why every unauthenticated endpoint with a side effect is on one.
  {
    pattern: "/api/*",
    max: 100,
    window: 60,
    keyStrategy: "session",
    addressCeiling: true,
  },
];

/**
 * Standard-tier MCP budget: the per-caller ceiling on tool calls, counted
 * inside the MCP tool wrapper rather than at the HTTP edge.
 *
 * The middleware rule below charges one unit per POST, but the transport
 * dispatches every message of a JSON-RPC batch to a handler, so a batched
 * request buys more work than it is billed for. Metering here is what makes
 * the advertised budget a call budget. Values MUST mirror the `/api/mcp` rule
 * and the `RATE_LIMIT_MCP` binding, so a caller sending one call per request
 * meets both limbs at the same point and neither shortens the other.
 */
export const MCP_STANDARD_LIMIT = { max: 100, window: 60 } as const;

/**
 * Heavy-tier MCP budget: 20 calls per 60s per caller for the expensive tool
 * shapes (deep lenses, project overview, wide graph walks, large batches).
 * Enforced inside the MCP tool wrapper — middleware cannot see tool names —
 * against the `mcpHeavy` backend slot. On Workers the values MUST mirror the
 * `RATE_LIMIT_MCP_HEAVY` binding's `simple.limit`/`simple.period` in
 * `wrangler.jsonc` (same invariant as {@link RateLimitRule}).
 */
export const MCP_HEAVY_LIMIT = { max: 20, window: 60 } as const;

/** SSE path pattern — excluded from request rate limiting (single per-user
 * stream, throughput is broker-bound rather than request-rate-bound). */
const SSE_PATTERN = /^\/api\/events$/;

/**
 * Find the first matching rate limit rule for a pathname.
 * SSE paths are excluded (single long-lived stream per user).
 *
 * Trailing slashes are stripped before matching, mirroring the auth
 * route handler's normalization (`app/api/auth/[...all]/route.ts`) and
 * Better Auth's `normalizePathname`. Without this, an exact-pattern rule
 * like `/api/auth/oauth2/register` would miss `/register/` — a path the
 * handler still serves — dropping the request onto the looser `/api/*`
 * catch-all whose session-cookie key an unauthenticated caller can mint
 * at will.
 *
 * @param pathname - URL pathname to match against rules.
 * @returns The first matching rule, or null if no match.
 */
export function matchRule(pathname: string): RateLimitRule | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (SSE_PATTERN.test(path)) return null;

  for (const rule of RATE_LIMIT_RULES) {
    if (rule.pattern.endsWith("/*")) {
      const prefix = rule.pattern.slice(0, -1);
      if (path.startsWith(prefix)) return rule;
    } else if (path === rule.pattern) {
      return rule;
    }
  }
  return null;
}

/**
 * Count a request against a rule's address ceiling, when it declares one and
 * a client address can be trusted.
 *
 * Skipped when the primary key already is that address, which happens on the
 * catch-all whenever a caller sends no session cookie. The two counters would
 * carry the same identity at the same budget, so the second changes no outcome
 * and costs one more binding call on a path anonymous callers reach.
 *
 * @param request - Incoming request.
 * @param rule - The matched rule.
 * @param primaryKey - The key the rule's own counter is using.
 * @returns The ceiling's result, or `null` when no ceiling applies.
 */
export async function checkAddressCeiling(
  request: NextRequest,
  rule: RateLimitRule,
  primaryKey?: string,
): Promise<RateLimitResult | null> {
  if (!rule.addressCeiling) return null;
  const address = resolveClientIp(request.headers);
  if (!address || primaryKey === address) return null;
  return getBackend(rule.bindingKey).check(
    `${rule.pattern}:addr:${address}`,
    rule.max,
    rule.window,
  );
}

/**
 * Extract the rate limit key from a request based on the rule's key strategy.
 *
 * The session strategy hashes the cookie rather than returning it: the raw
 * value is a live credential, and the key reaches structured logs on the
 * Workers backend when the rate-limit binding fails.
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
      return cookie ? await hashKey(cookie) : getClientIp(request);
    }
    case "apikey": {
      const auth = request.headers.get("authorization");
      if (auth?.startsWith("Bearer ")) return hashKey(auth.slice(7));
      return getClientIp(request);
    }
    case "ip":
      return getClientIp(request);
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
 * Extract the client IP to key a rate-limit bucket on.
 *
 * Delegates to the deployment's trust policy, so a caller cannot supply its
 * own bucket identity by setting a proxy header. Callers that cannot be
 * attributed share one bucket rather than getting a fresh one each.
 *
 * @param request - Incoming request.
 * @returns Client IP address, or the shared untrusted-caller key.
 */
function getClientIp(request: NextRequest): string {
  return clientIpKey(request.headers);
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

/**
 * Corrective 429 body for the MCP standard tier. Mirrors the heavy-tier
 * copy in `lib/mcp/create-server.ts`: names the budget, the retry window,
 * and the call-volume levers, so an agent can recover from the body text
 * alone. On the Cloudflare backend `resetIn` is the full window (an upper
 * bound), matching the heavy tier's behavior.
 *
 * @param max - Rule call budget per window.
 * @param window - Rule window in seconds.
 * @param resetIn - Seconds until the budget resets.
 * @returns The corrective error message.
 */
export function mcpRateLimitMessage(
  max: number,
  window: number,
  resetIn: number,
): string {
  return (
    `MCP rate limit reached (${max} calls/${window}s, all tools combined). ` +
    `Retry in ${resetIn}s, or reduce call volume: batch task creation into one piyaz_create ` +
    `and combine field reads into one piyaz_get fields=[...].`
  );
}

type BackendKind = "api" | "auth" | "actions" | "mcp" | "mcpHeavy";

/**
 * Backend slot table keyed by kind. `worker-cf.ts` wires `api`, `auth`,
 * `mcp`, and `mcpHeavy` to the matching Cloudflare bindings on first
 * request; `actions` is intentionally never bound (server actions declare
 * tighter `max` values than any single CF binding can enforce, so they stay
 * on the per-isolate `MemoryRateLimitBackend` where rule limits are honored
 * exactly).
 */
const _backends: Record<BackendKind, RateLimitBackend | null> = {
  api: null,
  auth: null,
  actions: null,
  mcp: null,
  mcpHeavy: null,
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
 * @param kind - Binding slot to write.
 * @param backend - The backend instance to register for that slot.
 */
export function setBackend(kind: BackendKind, backend: RateLimitBackend): void {
  _backends[kind] = backend;
}
