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
 * Re-exports `MymirBroker` so the OpenNext build inlines the class into the
 * worker bundle and the `MYMIR_BROKER` Durable Object binding in
 * `wrangler.jsonc` can resolve it.
 */
export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
  queue: doQueue,
  tagCache: d1NextTagCache,
  enableCacheInterception: true,
});

export { MymirBroker } from "./lib/realtime/broker-do";
