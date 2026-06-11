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
