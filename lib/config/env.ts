/**
 * Parse a non-negative integer tunable from an environment variable.
 *
 * Used for operator-facing limits where `0` is a meaningful value (e.g. a
 * hard freeze) and a malformed value should fall back rather than silently
 * coerce. The naive `Number(process.env.X) || fallback` pattern is wrong on
 * both counts: it treats an explicit `0` as unset, and turns a typo'd value
 * into the fallback without signal.
 *
 * @param raw - Raw environment value (`process.env.X`), possibly undefined.
 * @param fallback - Value to use when `raw` is unset or not a non-negative finite number.
 * @returns The parsed integer when `raw` is a non-negative finite number, else `fallback`.
 */
export function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

/**
 * Whether self-service signup is disabled (invite-only) for this deployment.
 *
 * Single source of truth for both the backend gate (`disableSignUp` in
 * `lib/auth.ts`) and the sign-up page UI, so the two cannot diverge. Fail
 * closed: signup is open only for self-hosters and the dev Worker; every other
 * hosted deploy is invite-only. Self-host is detected by the absence of the
 * Cloudflare deploy target; the dev Worker opts in via `SIGNUPS_ENABLED=true`
 * (set by `deploy:cf:dev`). Prod and any misconfigured hosted build get no
 * opt-in and stay disabled. Both flags are `NEXT_PUBLIC_*`, inlined at build,
 * so the server gate and the static sign-up page read the same baked values.
 *
 * @returns `true` when signups are disabled (invite-only), else `false`.
 */
export function signupsDisabled(): boolean {
  const isHosted = process.env.NEXT_PUBLIC_DEPLOY_TARGET === "cloudflare";
  const signupsEnabled = process.env.NEXT_PUBLIC_SIGNUPS_ENABLED === "true";
  return isHosted && !signupsEnabled;
}
