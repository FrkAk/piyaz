import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";

/**
 * OpenNext Cloudflare build configuration.
 *
 *   - `incrementalCache: r2IncrementalCache` — ISR / SSG cache backed by the
 *     `NEXT_INC_CACHE_R2_BUCKET` R2 binding.
 *   - `queue: doQueue` — revalidation queue backed by OpenNext's built-in
 *     `DOQueueHandler` Durable Object (separate from `MymirBroker`).
 *   - `tagCache: d1NextTagCache` — tag-revalidation cache backed by the
 *     `NEXT_TAG_CACHE_D1` D1 database.
 *   - `enableCacheInterception: true` — OpenNext-recommended default.
 *
 * `MymirBroker` is injected into `.open-next/worker.js` by
 * `scripts/postbuild-cf.ts`; re-exporting it here is dead code because the
 * OpenNext worker template does not consume user exports from this file.
 */
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: doQueue,
  tagCache: d1NextTagCache,
  enableCacheInterception: true,
});
