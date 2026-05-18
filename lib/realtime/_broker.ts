/**
 * Indirection point for the realtime broker.
 *
 * `next.config.ts`'s webpack alias rewrites this import to
 * `./_broker.workers` on Cloudflare builds and to `./_broker.node`
 * everywhere else. The Node variant is the existing in-memory broker;
 * the Workers variant proxies to the `MymirBroker` Durable Object.
 */
export * from "./_broker.node";
