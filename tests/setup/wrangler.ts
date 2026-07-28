/**
 * Comment-tolerant reader for the `ratelimits` bindings in `wrangler.jsonc`,
 * for tests that pin declared budgets to what the Cloudflare bindings
 * enforce. `Bun.file(...).json()` rejects JSONC the day a real comment lands
 * in the file, so the stripper mirrors `scripts/assert-deploy-ready.ts`.
 */

/** One `ratelimits[]` binding as declared in `wrangler.jsonc`. */
export type RatelimitBinding = {
  /** Binding name, e.g. `RATE_LIMIT_API`. */
  name: string;
  /** The limit the Workers runtime enforces. */
  simple: { limit: number; period: number };
};

/**
 * Strip `// line` and `/* block *\/` comments so the JSONC config parses
 * with the standard `JSON.parse`. The `(^|[^:])` guard keeps `https://`
 * string values intact.
 *
 * @param source - JSONC text.
 * @returns Plain JSON text.
 */
function stripJsonc(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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
