/**
 * Indirection point for the RLS read-batch backend.
 *
 * `next.config.ts`'s webpack plugin rewrites this import to
 * `./rls-read.workers` on Cloudflare builds and to `./rls-read.node`
 * everywhere else. The Workers variant sends one neon-http batch
 * transaction per call; the Node variant wraps one read-only postgres-js
 * interactive transaction. Both set the same `app.user_id` GUC before any
 * statement runs.
 */
export * from "./rls-read.node";
