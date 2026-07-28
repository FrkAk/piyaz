/**
 * Comment-tolerant reader for the `ratelimits` bindings in `wrangler.jsonc`,
 * for tests that pin declared budgets to what the Cloudflare bindings
 * enforce. `Bun.file(...).json()` rejects JSONC the day a real comment lands
 * in the file, so the config passes through the shared `stripJsonc` first.
 */
import { stripJsonc } from "@/lib/config/jsonc";

/** One `ratelimits[]` binding as declared in `wrangler.jsonc`. */
export type RatelimitBinding = {
  /** Binding name, e.g. `RATE_LIMIT_API`. */
  name: string;
  /** The limit the Workers runtime enforces. */
  simple: { limit: number; period: number };
};

/**
 * Read one Worker environment's `ratelimits` bindings from `wrangler.jsonc`.
 *
 * @param env - Worker environment section to read.
 * @returns The declared ratelimit bindings.
 * @throws Error when the section carries none.
 */
export async function wranglerRatelimits(
  env: "production" | "dev",
): Promise<RatelimitBinding[]> {
  const source = await Bun.file(
    `${import.meta.dir}/../../wrangler.jsonc`,
  ).text();
  const config = JSON.parse(stripJsonc(source)) as {
    env?: Record<string, { ratelimits?: RatelimitBinding[] }>;
  };
  const ratelimits = config.env?.[env]?.ratelimits;
  if (!ratelimits?.length) {
    throw new Error(`wrangler.jsonc env.${env} declares no ratelimits`);
  }
  return ratelimits;
}
