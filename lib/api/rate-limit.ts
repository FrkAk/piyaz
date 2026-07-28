import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import {
  clientIpKey,
  hasTrustedAddressSource,
  resolveClientIp,
  UNTRUSTED_BUDGET_FACTOR,
  UNTRUSTED_IP_KEY,
} from "@/lib/security/client-ip";
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
 * `'mcp'` → `RATE_LIMIT_MCP`, `'mcpHeavy'` → `RATE_LIMIT_MCP_HEAVY`; the
 * address ceiling has its own `RATE_LIMIT_ADDRESS`).
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
   * caller-supplied, so rotating that value cannot escape the budget. Charged
   * against {@link ADDRESS_CEILING} rather than the rule's own `max`, because a
   * per-caller budget applied to a shared egress address throttles everyone
   * behind it. Skipped when no address resolves, which keeps a deployment with
   * no declared proxy from collapsing every caller into one bucket.
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
 * Pre-auth rules use the `"ip"` key strategy, never `"session"`: these
 * endpoints are reached by unauthenticated callers, and `getSessionCookie`
 * returns the raw cookie value unvalidated, so a `"session"` key could be
 * rotated to mint a fresh bucket per request. An endpoint earns a rule here
 * when an anonymous caller can reach it and make it cost something (an email,
 * an `oauthClient` row, a token-grant attempt, a deleted account); the rest of
 * the allowlist in `app/api/auth/[...all]/route.ts` fails that test and stays
 * on the catch-all with its address ceiling.
 *
 * IP keys collide behind shared NATs, which Cloudflare's guidance warns about
 * for general throttling; brute-force defense by IP is the exception. Better
 * Auth's in-process `customRules` (`lib/auth.ts`) layer on top.
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
    // Prefix match: the token rides in the path segment (GET
    // `/reset-password/:token`). Consumes a high-entropy token rather than
    // guessing a credential, so it carries the general budget.
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
    // Emailed high-entropy-token GET that deletes the account: off the
    // catch-all's forgeable cookie key, on the general budget.
    pattern: "/api/auth/delete-user/callback",
    max: 100,
    window: 60,
    keyStrategy: "ip",
    bindingKey: "api",
  },
  {
    // MCP refresh traffic, not credential guessing: the brute-force budget
    // would throttle a normal client fleet. The `ip` strategy takes it off
    // the catch-all's forgeable cookie key at the general budget.
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
    // The bearer token is unverified caller bytes, so the token bucket alone
    // bounds nothing; the address ceiling is what an unauthenticated flood
    // runs into.
    addressCeiling: true,
  },
  // The session cookie is unverified here, so rotation could mint buckets
  // without limit; the address ceiling bounds that. A forged cookie buys a
  // fresh counter, never a fresh address. Where no address resolves the
  // ceiling is skipped and only the enumerated `"ip"` rules above bind.
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
 * Budget for the address ceiling, on its own `RATE_LIMIT_ADDRESS` binding.
 *
 * Deliberately far looser than the rules it backstops. The ceiling exists so
 * that rotating a forged cookie or a random bearer token cannot mint unlimited
 * counters; it is not the per-caller budget. Sized to the primary's value it
 * would instead become the binding constraint for every caller sharing one
 * egress address, which is what Cloudflare's own guidance warns about for
 * IP-keyed limits: an office behind one NAT would throttle itself on ordinary
 * traffic long before any individual met their session budget.
 *
 * MUST equal `simple.limit` and `simple.period` on the `RATE_LIMIT_ADDRESS`
 * binding in `wrangler.jsonc`, which is what actually enforces on the hosted
 * target: the binding accepts no per-call override, so these values only
 * partition counters and fill the advertised header there.
 */
export const ADDRESS_CEILING = { max: 1000, window: 60 } as const;

/**
 * Resolve the budget a key actually gets, widening it where the key is the
 * shared bucket every unattributable caller falls into.
 *
 * A per-address `max` becomes an instance-wide ceiling once identity collapses,
 * which denies service rather than throttling abuse. Both conditions are
 * required: the key has to be the shared one, and the deployment has to declare
 * no address source, so a hosted request that happens to carry no address keeps
 * the budget its Cloudflare binding enforces instead of advertising a limit the
 * binding will not honor.
 *
 * @param max - The rule's per-caller budget.
 * @param key - The key the counter is using.
 * @returns The budget to charge against, widened only for the shared bucket.
 */
export function effectiveMax(max: number, key: string): number {
  return key === UNTRUSTED_IP_KEY && !hasTrustedAddressSource()
    ? max * UNTRUSTED_BUDGET_FACTOR
    : max;
}

/**
 * Count a request against the shared per-address ceiling, when the rule
 * declares one and a client address can be trusted.
 *
 * The key is the address alone, so one address holds one
 * {@link ADDRESS_CEILING} budget across every ceiling-bearing rule. Skipped
 * when the primary key already is that address: both counters would carry the
 * same identity, and the looser ceiling can never reject first. The middleware
 * charges it only after the primary admits, so rejected requests do not burn
 * the shared budget.
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
  return getBackend("address").check(
    `addr:${address}`,
    ADDRESS_CEILING.max,
    ADDRESS_CEILING.window,
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

/** Cached HMAC key, re-derived when the secret changes (tests flip env). */
let hmacCache: { secret: string; key: Promise<CryptoKey> } | null = null;

/**
 * Import the HMAC key for {@link hashKey}, cached per secret value.
 *
 * @param secret - The signing secret.
 * @returns The imported HMAC-SHA256 key.
 */
function hmacKey(secret: string): Promise<CryptoKey> {
  if (hmacCache?.secret !== secret) {
    hmacCache = {
      secret,
      key: crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    };
  }
  return hmacCache.key;
}

/**
 * Digest a credential into a rate-limit key.
 *
 * HMAC-SHA256 keyed on `BETTER_AUTH_SECRET`: keys reach persisted logs when a
 * binding fails, and an unkeyed digest of a credential is an offline oracle
 * for it. Falls back to plain SHA-256 when the secret is absent rather than
 * failing the limiter; boot requires the secret everywhere that matters.
 *
 * @param value - The credential to digest.
 * @returns Hex-encoded digest.
 */
async function hashKey(value: string): Promise<string> {
  const secret = process.env.BETTER_AUTH_SECRET;
  const data = new TextEncoder().encode(value);
  const buf = secret
    ? await crypto.subtle.sign("HMAC", await hmacKey(secret), data)
    : await crypto.subtle.digest("SHA-256", data);
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
 *
 * The advertised policy is always the primary rule's effective limit, never
 * the address ceiling's: the ceiling is a shared backstop, and advertising its
 * budget as the caller's own overstates what the rule grants. `remaining` is
 * clamped to the policy for the same reason; `Retry-After` reports whichever
 * limb rejected.
 *
 * @param result - Rate limit check result (primary or ceiling).
 * @param rule - The matched rate limit rule.
 * @param policyLimit - The primary rule's effective budget for this key.
 * @returns Header name-value map including RateLimit-Policy, RateLimit, and Retry-After (when blocked).
 */
export function rateLimitHeaders(
  result: RateLimitResult,
  rule: RateLimitRule,
  policyLimit: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Policy": `${policyLimit};w=${rule.window}`,
    RateLimit: `limit=${policyLimit}, remaining=${Math.min(result.remaining, policyLimit)}, reset=${result.resetIn}`,
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

type BackendKind = "api" | "auth" | "actions" | "mcp" | "mcpHeavy" | "address";

/**
 * Backend slot table keyed by kind. `worker-cf.ts` wires `api`, `auth`,
 * `mcp`, `mcpHeavy`, and `address` to the matching Cloudflare bindings on
 * first request; `actions` is intentionally never bound (server actions declare
 * tighter `max` values than any single CF binding can enforce, so they stay
 * on the per-isolate `MemoryRateLimitBackend` where rule limits are honored
 * exactly).
 *
 * Pinned to a `globalThis` slot keyed by `Symbol.for(...)`, for the same
 * reason `lib/db/request-store.ts` pins its store: the Workers artifact holds
 * more than one copy of this module, because `worker-cf.ts` reaches it through
 * wrangler's esbuild while middleware and the server handler reach it through
 * Next's webpack. Without the pin, `setBackend` writes the copy the entry
 * point sees and `getBackend` reads a different one, so every reader silently
 * falls back to the per-isolate memory backend and the Cloudflare bindings
 * bound nothing.
 */
const BACKENDS_KEY = Symbol.for("@piyaz/api/rateLimitBackends");
const symbolKeyedGlobal = globalThis as Record<symbol, unknown>;
symbolKeyedGlobal[BACKENDS_KEY] ??= {
  api: null,
  auth: null,
  actions: null,
  mcp: null,
  mcpHeavy: null,
  address: null,
} satisfies Record<BackendKind, RateLimitBackend | null>;
const _backends = symbolKeyedGlobal[BACKENDS_KEY] as Record<
  BackendKind,
  RateLimitBackend | null
>;

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
