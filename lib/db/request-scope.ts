/**
 * Indirection point for the per-request DB seeding helper.
 *
 * `next.config.ts`'s webpack alias rewrites this import to
 * `./request-scope.workers` on Cloudflare builds and to
 * `./request-scope.node` everywhere else. The Node variant is a no-op
 * (self-host reuses globalThis-cached pools); the Workers variant
 * scopes pools per-request and schedules `ctx.waitUntil(pool.end())`.
 */
export * from "./request-scope.node";
