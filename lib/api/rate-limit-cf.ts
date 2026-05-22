import type { RateLimitBackend, RateLimitResult } from "./rate-limit";

/**
 * Cloudflare Workers Rate Limit Binding type. Structurally mirrors the
 * canonical `RateLimit` from `@cloudflare/workers-types` (`limit({key}) =>
 * Promise<{success}>`) but declared locally so we don't pull in that
 * package's ambient declarations — they would clobber DOM `Request` /
 * `Response` and break unrelated browser tests. Project convention
 * enforced by `no-restricted-imports` in `eslint.config.*`; see
 * `lib/realtime/broker-do.ts:30-36` for the same pattern.
 */
export type CloudflareRateLimitBinding = {
  limit: (opts: { key: string }) => Promise<{ success: boolean }>;
};

/**
 * Constructor options for {@link CloudflareRateLimitBackend}.
 *
 * `failOpen` selects the behavior when the binding RPC itself rejects (CF
 * does not document RPC-error semantics for this binding, so the choice is
 * an explicit availability/security tradeoff, not platform conformance):
 * - `true` — return `allowed: true` so a degraded rate-limit subsystem does
 *   not take the app offline. Appropriate for general API throttling.
 * - `false` — return `allowed: false` so an outage cannot become a hole in
 *   a brute-force defense. Appropriate for auth-adjacent endpoints.
 */
export type CloudflareRateLimitBackendOptions = {
  failOpen?: boolean;
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
  private readonly failOpen: boolean;

  /**
   * @param binding - The Cloudflare rate-limit binding from `env`.
   * @param options - Optional overrides; `failOpen` defaults to `true`.
   */
  constructor(
    private binding: CloudflareRateLimitBinding,
    options: CloudflareRateLimitBackendOptions = {},
  ) {
    this.failOpen = options.failOpen ?? true;
  }

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
   * authoritative quota math. Callers should keep `rule.max` equal to the
   * backing binding's `simple.limit` so headers do not misrepresent.
   *
   * On binding RPC error the behavior follows the `failOpen` ctor option
   * (see {@link CloudflareRateLimitBackendOptions}). The structured warning
   * lets `wrangler tail` surface degraded bindings in either mode.
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
          failOpen: this.failOpen,
          error: String(err),
        }),
      );
      return {
        allowed: this.failOpen,
        limit: max,
        remaining: this.failOpen ? max : 0,
        resetIn: windowSeconds,
      };
    }
  }
}
