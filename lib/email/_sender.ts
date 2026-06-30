/**
 * Indirection point for the per-runtime email platform transport.
 *
 * `next.config.ts`'s webpack alias rewrites this import to `_sender.workers`
 * on Cloudflare builds (`DEPLOY_TARGET=cloudflare`) and to `_sender.node`
 * everywhere else. Re-exporting from `_sender.node` keeps `bun run typecheck`
 * and self-host builds working when the alias is not active. Mirrors
 * `lib/db/_driver.ts`.
 */
export * from "./_sender.node";
