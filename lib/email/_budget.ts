/**
 * Indirection point for the per-runtime email budget store.
 *
 * `next.config.ts`'s webpack alias rewrites this import to `_budget.workers`
 * on Cloudflare builds (`DEPLOY_TARGET=cloudflare`) and to `_budget.node`
 * everywhere else. Re-exporting from `_budget.node` keeps `bun run typecheck`
 * and self-host builds working when the alias is not active. Mirrors
 * `lib/email/_sender.ts`.
 */
export * from "./_budget.node";
