import path from "node:path";
import type { NextConfig } from "next";
import { headerRules } from "./lib/security/headers";

const isCloudflare = process.env.DEPLOY_TARGET === "cloudflare";
const PROJECT_ROOT = process.cwd();
const DRIVER_TARGET = isCloudflare ? "workers" : "node";

const TARGET_FILES = [
  ["lib/db/_driver", `lib/db/_driver.${DRIVER_TARGET}`],
  ["lib/db/request-scope", `lib/db/request-scope.${DRIVER_TARGET}`],
  ["lib/db/rls-read", `lib/db/rls-read.${DRIVER_TARGET}`],
  ["lib/db/_auth-kv-storage", `lib/db/_auth-kv-storage.${DRIVER_TARGET}`],
  ["lib/realtime/_broker", `lib/realtime/_broker.${DRIVER_TARGET}`],
] as const;

/**
 * Each alternative pins the basename to its own parent directory so an
 * unrelated file with a matching basename in a sibling tree (e.g.
 * `lib/realtime/_driver.ts` or `lib/db/_broker.ts`) is never silently
 * aliased to the wrong sibling. Rebuilt directly from `TARGET_FILES` so
 * adding a new indirection only touches that constant.
 */
const REPLACEMENT_REGEX = new RegExp(
  `(^|/)(${TARGET_FILES.map(([from]) => from).join("|")})(\\.[cm]?[tj]sx?)?$`,
);

/**
 * Rewrite a driver / broker indirection import to its per-target sibling.
 * Anchored on the `lib/db/` and `lib/realtime/` parents so test fixtures or
 * transitive deps sharing a basename are never touched. Runs at
 * module-resolution time so the unused target never enters the bundle.
 *
 * @param resource - Module-resolution data mutated in place by webpack.
 */
function rewriteDriverImport(resource: { request: string; context?: string }) {
  const match = resource.request.match(REPLACEMENT_REGEX);
  if (!match) return;
  const fullPath = match[2];
  const replacement = TARGET_FILES.find(([from]) => from === fullPath);
  if (!replacement) return;
  resource.request = path.resolve(PROJECT_ROOT, `${replacement[1]}.ts`);
}

/**
 * Async factory so the OpenNext dev-mode initializer can be `await`ed
 * without top-level await in the config module — Next loads the compiled
 * config via `require()`, which rejects async modules.
 *
 * @returns Next config with `output: "standalone"` gated on
 *   `DEPLOY_TARGET=cloudflare` and webpack aliases pointed at the
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
    /**
     * Surface deploy-time flags to the bundle. `NEXT_PUBLIC_*` is inlined by
     * Next at build, so both the server gate and the static sign-up page read
     * the same baked value. `NEXT_PUBLIC_DEPLOY_TARGET`: self-host builds get
     * an empty string, Cloudflare builds get `"cloudflare"`.
     * `NEXT_PUBLIC_SIGNUPS_ENABLED`: `"true"` opts a hosted deploy into open
     * signup (set by `deploy:cf:dev`); hosted deploys are invite-only without it.
     */
    env: {
      NEXT_PUBLIC_DEPLOY_TARGET: process.env.DEPLOY_TARGET ?? "",
      NEXT_PUBLIC_SIGNUPS_ENABLED: process.env.SIGNUPS_ENABLED ?? "",
    },
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
