/**
 * Turnstile all-or-nothing deploy guard.
 *
 * The two keys reach a deploy by different routes: `TURNSTILE_SECRET_KEY` at
 * runtime as a Worker secret, `TURNSTILE_SITE_KEY` at build time through
 * `next.config.ts`'s `env` block. They can drift apart, and either half alone
 * ships a broken deploy, so the rule is symmetric rather than making the
 * secret required: both absent is the documented rollback state for a
 * Turnstile outage and must pass.
 *
 * Lives outside `assert-deploy-ready.ts` so the rule itself is a pure function
 * with tests. That script runs only for production and shells out to wrangler
 * at import time; this module is also the entry point the dev deploy uses,
 * since dev has its own widget and its own secret and is where drift is most
 * likely.
 *
 * Run directly: `bun run scripts/turnstile-symmetry.ts --env <name>`.
 */

/** Inputs the symmetry rule decides on. */
interface SymmetryInput {
  /** Wrangler environment name, used in the remediation text. */
  env: string;
  /** Whether `TURNSTILE_SECRET_KEY` is registered for that environment. */
  secretPresent: boolean;
  /** Whether `TURNSTILE_SITE_KEY` is set in the build environment. */
  siteKeyPresent: boolean;
}

/**
 * Apply the all-or-nothing rule.
 *
 * @param input - Environment name and the presence of each half.
 * @returns Failure messages; empty when the deploy is consistent.
 */
export function turnstileSymmetryFailures(input: SymmetryInput): string[] {
  const { env, secretPresent, siteKeyPresent } = input;
  if (secretPresent && !siteKeyPresent) {
    return [
      `TURNSTILE_SECRET_KEY is registered in the '${env}' Wrangler env but ` +
        `TURNSTILE_SITE_KEY is not set in the build environment. The captcha ` +
        `plugin would arm server-side with no widget to mint a token, ` +
        `rejecting every sign-up and sign-in. Export TURNSTILE_SITE_KEY for ` +
        `the build, or delete the secret to deploy with Turnstile off.`,
    ];
  }
  if (siteKeyPresent && !secretPresent) {
    return [
      `TURNSTILE_SITE_KEY is set in the build environment but ` +
        `TURNSTILE_SECRET_KEY is not registered in the '${env}' Wrangler ` +
        `env. The widget would mint tokens the server never verifies, ` +
        `leaving bot protection silently off while appearing on. Set it via ` +
        `'wrangler secret put TURNSTILE_SECRET_KEY --env ${env}', or unset ` +
        `TURNSTILE_SITE_KEY to deploy with Turnstile off.`,
    ];
  }
  return [];
}

/** One entry of `wrangler secret list --json`. */
interface WranglerSecretEntry {
  name: string;
}

/**
 * Whether `TURNSTILE_SECRET_KEY` is registered for an environment.
 *
 * @param env - Wrangler environment name.
 * @returns `true` when present, or `null` when wrangler could not be queried.
 */
function secretRegistered(env: string): boolean | null {
  const result = Bun.spawnSync({
    cmd: ["bunx", "wrangler", "secret", "list", "--env", env],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(
      result.stdout.toString().trim(),
    ) as WranglerSecretEntry[];
    return parsed.some((entry) => entry.name === "TURNSTILE_SECRET_KEY");
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--env");
  const env = flag === -1 ? "production" : (process.argv[flag + 1] ?? "");
  if (env.length === 0) {
    console.error("Turnstile guard: --env requires an environment name.");
    process.exit(1);
  }

  const secretPresent = secretRegistered(env);
  if (secretPresent === null) {
    console.error(
      `Turnstile guard: could not enumerate Wrangler secrets in the '${env}' ` +
        `env, so the all-or-nothing check could not run.`,
    );
    process.exit(1);
  }

  const failures = turnstileSymmetryFailures({
    env,
    secretPresent,
    siteKeyPresent: (process.env.TURNSTILE_SITE_KEY ?? "").length > 0,
  });
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Turnstile guard: '${env}' keys are consistent.`);
}
