/**
 * Indirection point for the per-runtime floating email-send enrollment.
 *
 * `next.config.ts`'s webpack alias rewrites this import to `_defer.workers`
 * on Cloudflare builds (`DEPLOY_TARGET=cloudflare`) and to `_defer.node`
 * everywhere else. Re-exporting from `_defer.node` keeps `bun run typecheck`
 * and self-host builds working when the alias is not active. Mirrors
 * `lib/email/_sender.ts`.
 */
export * from "./_defer.node";
