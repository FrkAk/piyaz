import type { RateLimitBackend, RateLimitResult } from "./rate-limit";

/**
 * Cloudflare Workers Rate Limit Binding type.
 * Matches the binding API shape from wrangler.toml [[rate_limiting]].
 */
export type CloudflareRateLimitBinding = {
  limit: (opts: { key: string }) => Promise<{ success: boolean }>;
};

/**
 * Cloudflare Workers rate limit backend.
 *
 * Uses the CF Rate Limit Binding for per-POP, eventually-consistent rate
 * limiting. Counters are cached per-isolate-machine within a POP and
 * async-synced to a POP-level backing store, so this is NOT globally
 * consistent — multi-POP attackers can still get `simple.limit × M POPs`.
 * The benefit over the in-memory backend is per-POP shared state instead
 * of per-isolate-only.
 */
export class CloudflareRateLimitBackend implements RateLimitBackend {
  constructor(private binding: CloudflareRateLimitBinding) {}

  /**
   * Check and consume one request against the rate limit via CF binding.
   *
   * The composite key `${key}:${max}:${windowSeconds}` disambiguates multiple
   * rules sharing one binding — the binding's `simple.limit` and
   * `simple.period` (declared in `wrangler.jsonc:ratelimits[]`) are the
   * actual enforcement; `max` and `windowSeconds` here only partition the
   * counter namespace. The binding API only returns `{success}`, so the
   * `remaining` and `resetIn` fields below are approximated by `max` and
   * `windowSeconds` — they drive advisory IETF `RateLimit` headers, not
   * authoritative quota math.
   *
   * Fails open on RPC error (returns `allowed: true`) to match Cloudflare's
   * documented platform behavior under infrastructure overload. The
   * structured warning lets `wrangler tail` surface degraded bindings.
   *
   * @param key - Unique key identifying the client.
   * @param max - Maximum requests allowed in the window (per the rule).
   * @param windowSeconds - Window duration in seconds (per the rule).
   * @returns Result with allowed status and approximate quota info.
   */
  async check(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const compositeKey = `${key}:${max}:${windowSeconds}`;
    try {
      const result = await this.binding.limit({ key: compositeKey });
      return {
        allowed: result.success,
        limit: max,
        remaining: result.success ? max - 1 : 0,
        resetIn: windowSeconds,
      };
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "rate_limit_binding_error",
          key: compositeKey,
          error: String(err),
        }),
      );
      return {
        allowed: true,
        limit: max,
        remaining: max,
        resetIn: windowSeconds,
      };
    }
  }
}
