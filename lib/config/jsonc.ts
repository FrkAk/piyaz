/**
 * Comment stripping for JSONC configuration files. Single copy shared by the
 * deploy guard (`scripts/assert-deploy-ready.ts`) and the test-side wrangler
 * reader (`tests/setup/wrangler.ts`), so a parsing fix in one consumer cannot
 * drift from the other.
 */

/**
 * Strip `// line` and `/* block *\/` comments so JSONC parses with the
 * standard `JSON.parse`, keeping the file readable without a dedicated JSONC
 * parser as a dev dependency. The `(^|[^:])` guard keeps `https://` string
 * values intact.
 *
 * @param source - JSONC text.
 * @returns Plain JSON text.
 */
export function stripJsonc(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
