import path from "node:path";
import type { NextConfig } from "next";
import { headerRules } from "./lib/security/headers";

const isCloudflare = process.env.DEPLOY_TARGET === "cloudflare";
const PROJECT_ROOT = process.cwd();
const DRIVER_TARGET = isCloudflare ? "workers" : "node";

const TARGET_FILES = [
  ["lib/db/_driver", `lib/db/_driver.${DRIVER_TARGET}`],
  ["lib/db/request-scope", `lib/db/request-scope.${DRIVER_TARGET}`],
  ["lib/realtime/_broker", `lib/realtime/_broker.${DRIVER_TARGET}`],
] as const;

const REPLACEMENT_REGEX = new RegExp(
  `(^|/)lib/(?:db|realtime)/(${TARGET_FILES.map(
    ([from]) => from.split("/").pop(),
  ).join("|")})(\\.[cm]?[tj]sx?)?$`,
);

/**
 * Rewrites runtime imports of the driver / broker indirection files to
 * the per-target sibling. The regex is anchored on the `lib/db/` and
 * `lib/realtime/` parent directories so files with the same basename
 * elsewhere in the tree (test fixtures, transitive deps) are never
 * touched. Runs at module-resolution time so the imports are swapped
 * before any code from the unused target reaches the bundle.
 *
 * Triggered by `next.config.ts`'s webpack hook below.
 *
 * @param resource - Module-resolution data webpack passes us in-place.
 */
function rewriteDriverImport(resource: { request: string; context?: string }) {
  const match = resource.request.match(REPLACEMENT_REGEX);
  if (!match) return;
  const baseName = match[2];
  const replacement = TARGET_FILES.find(([from]) => from.endsWith(baseName));
  if (!replacement) return;
  resource.request = path.resolve(PROJECT_ROOT, `${replacement[1]}.ts`);
}

/**
 * Async factory so the OpenNext dev-mode initializer can be `await`ed
 * without requiring top-level await in the config module (Next loads
 * the compiled config via `require()` which rejects async modules).
 *
 * @returns The Next.js config object, with `output: "standalone"` gated
 *   on `DEPLOY_TARGET=cloudflare` and webpack aliases pointed at the
 *   per-target driver / broker indirection files.
 */
async function buildNextConfig(): Promise<NextConfig> {
  if (isCloudflare) {
    const { initOpenNextCloudflareForDev } = await import(
      "@opennextjs/cloudflare"
    );
    initOpenNextCloudflareForDev();
  }

  return {
    ...(isCloudflare ? {} : { output: "standalone" }),
    poweredByHeader: false,
    experimental: {
      serverActions: {
        bodySizeLimit: "2mb",
      },
    },
    webpack(
      config: { plugins?: unknown[] },
      ctx: {
        webpack: {
          NormalModuleReplacementPlugin: new (
            re: RegExp,
            fn: (r: { request: string }) => void,
          ) => unknown;
        };
      },
    ) {
      const plugins = config.plugins ?? [];
      plugins.push(
        new ctx.webpack.NormalModuleReplacementPlugin(
          REPLACEMENT_REGEX,
          rewriteDriverImport,
        ),
      );
      config.plugins = plugins;
      return config;
    },
    async headers() {
      return headerRules(process.env.NODE_ENV === "production");
    },
  };
}

export default buildNextConfig;
