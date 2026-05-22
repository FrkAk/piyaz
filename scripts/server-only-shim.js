/**
 * Shim for the `server-only` package on the Cloudflare Workers bundle.
 *
 * `server-only/index.js` throws at import time so that bundlers building
 * client-side code error out. Next.js's webpack picks the package's
 * `react-server` export condition (`empty.js` — a no-op), but wrangler's
 * esbuild does not honor that condition, so it resolves to the throwing
 * default and crashes the worker at startup with code 10021.
 *
 * Workers always run server-side, so the guard the package provides is
 * meaningless here. This file replaces `server-only` with a no-op via the
 * `alias` field in `wrangler.jsonc`.
 *
 * Aliased from: `"alias": { "server-only": "./scripts/server-only-shim.js" }`.
 */
