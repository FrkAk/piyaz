/**
 * Public broker entrypoint. Re-exports the active backend selected at
 * build time via `next.config.ts`'s webpack alias on `./_broker`:
 *
 *   - Self-host (default): in-memory `Broker` from `./_broker.node`.
 *   - Cloudflare Workers (`DEPLOY_TARGET=cloudflare`): Durable Object-backed
 *     adapter from `./_broker.workers` that proxies to `MymirBroker`.
 *
 * Call sites import from this file so the alias swap is transparent.
 */
export * from "./_broker";
