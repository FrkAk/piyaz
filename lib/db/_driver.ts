/**
 * Indirection point for the DB driver.
 *
 * `next.config.ts`'s webpack alias rewrites this import to `_driver.workers`
 * on Cloudflare builds (`DEPLOY_TARGET=cloudflare`) and to `_driver.node`
 * everywhere else. Re-exporting from `_driver.node` keeps `bun run typecheck`
 * and self-host builds working when the alias is not active.
 */
export * from "./_driver.node";
