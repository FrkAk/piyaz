/**
 * Indirection point for the per-runtime email budget store.
 *
 * `next.config.ts`'s webpack alias rewrites this import to `_budget.workers`
 * on Cloudflare builds (`DEPLOY_TARGET=cloudflare`) and to `_budget.node`
 * everywhere else. Re-exporting from `_budget.node` keeps `bun run typecheck`
 * and self-host builds working when the alias is not active. Mirrors
 * `lib/email/_sender.ts`.
 */
// Star re-export: `tests/email/budget.test.ts` replaces this module with a
// process-global `mock.module` that must list every export by hand, so a new
// export here hands `undefined` to any file loaded after that one.
export * from "./_budget.node";
