/**
 * Indirection point for the Better Auth KV-backed secondaryStorage adapter.
 *
 * `next.config.ts`'s webpack plugin rewrites this import to
 * `_auth-kv-storage.workers` on `DEPLOY_TARGET=cloudflare` and to
 * `_auth-kv-storage.node` everywhere else. Re-exporting from the Node
 * sibling keeps `bun run typecheck` and self-host builds working when
 * the plugin is not active.
 */
export * from "./_auth-kv-storage.node";
