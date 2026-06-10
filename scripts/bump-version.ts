import { readFileSync, writeFileSync } from "node:fs";

const CONFIG_PATH = ".version-bump.json";
export const SEMVER = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const VERSION_CAPTURE = "(\\d+\\.\\d+\\.\\d+(?:-[A-Za-z0-9.]+)?)";

export interface FieldEntry {
  path: string;
  field: string;
}

export interface PatternEntry {
  path: string;
  pattern: string;
}

export type Entry = FieldEntry | PatternEntry;

export interface Config {
  files: Entry[];
}

export interface VersionLocation {
  path: string;
  version: string;
}

/**
 * Type guard for JSON-field version entries.
 * @param entry - Entry to test.
 * @returns True when the entry targets a JSON field.
 */
export function isFieldEntry(entry: Entry): entry is FieldEntry {
  return "field" in entry;
}

/**
 * Escape a string for literal use inside a regular expression.
 * @param value - Raw string.
 * @returns Regex-safe string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex from a config `pattern` by replacing the `{version}` token
 * with a capturing semver group; all other characters match literally.
 * @param pattern - Pattern string containing exactly one `{version}` token.
 * @returns Compiled regex with the version as capture group 1.
 * @throws Error when the pattern has zero or more than one `{version}` token.
 */
export function patternToRegExp(pattern: string): RegExp {
  const tokenCount = (pattern.match(/\{version\}/g) ?? []).length;
  if (tokenCount === 0) {
    throw new Error(`pattern is missing a {version} token: ${pattern}`);
  }
  if (tokenCount > 1) {
    throw new Error(`pattern has more than one {version} token: ${pattern}`);
  }
  const escaped = escapeRegExp(pattern).replace(
    escapeRegExp("{version}"),
    VERSION_CAPTURE,
  );
  return new RegExp(escaped);
}

/**
 * Read the current version recorded at one config entry.
 * @param entry - Field or pattern entry.
 * @returns The version string found at the entry.
 * @throws Error when the field or pattern is absent.
 */
export function readVersion(entry: Entry): string {
  const content = readFileSync(entry.path, "utf8");
  if (isFieldEntry(entry)) {
    const value = (JSON.parse(content) as Record<string, unknown>)[entry.field];
    if (typeof value !== "string") {
      throw new Error(`${entry.path} has no string ${entry.field} field`);
    }
    return value;
  }
  const match = content.match(patternToRegExp(entry.pattern));
  if (!match) {
    throw new Error(`${entry.path} does not match pattern: ${entry.pattern}`);
  }
  return match[1];
}

/**
 * Write a new version into one config entry, preserving file formatting.
 * @param entry - Field or pattern entry.
 * @param version - New version string.
 * @throws Error when the field or pattern is absent.
 */
export function writeVersion(entry: Entry, version: string): void {
  const content = readFileSync(entry.path, "utf8");
  if (isFieldEntry(entry)) {
    const re = new RegExp(`("${entry.field}"\\s*:\\s*")[^"]*(")`);
    if (!re.test(content)) {
      throw new Error(`${entry.path} has no ${entry.field} field to bump`);
    }
    writeFileSync(entry.path, content.replace(re, `$1${version}$2`));
    return;
  }
  const next = content.replace(patternToRegExp(entry.pattern), () =>
    entry.pattern.replace("{version}", version),
  );
  writeFileSync(entry.path, next);
}

/**
 * Read the recorded version at every config entry.
 * @param entries - Config file entries.
 * @returns One location record per entry, in config order.
 */
export function readVersions(entries: Entry[]): VersionLocation[] {
  return entries.map((entry) => ({
    path: entry.path,
    version: readVersion(entry),
  }));
}

/**
 * Find locations whose version differs from the canonical (first) entry.
 * @param locations - Version locations to compare.
 * @returns Locations that drift from the canonical version; empty when aligned.
 */
export function findDrift(locations: VersionLocation[]): VersionLocation[] {
  if (locations.length === 0) {
    return [];
  }
  const canonical = locations[0].version;
  return locations.filter((location) => location.version !== canonical);
}

/**
 * CLI entry point: `--check` reports drift, no argument prints the canonical
 * version, and a semver argument bumps every configured location.
 */
function main(): void {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  if (config.files.length === 0) {
    console.error(`No version locations configured in ${CONFIG_PATH}.`);
    process.exit(1);
  }

  const arg = process.argv[2];

  if (arg === "--check") {
    const locations = readVersions(config.files);
    const drift = findDrift(locations);
    const canonical = locations[0].version;
    if (drift.length > 0) {
      console.error(`Version drift (canonical ${canonical}):`);
      for (const location of drift) {
        console.error(`  ${location.version}  ${location.path}`);
      }
      console.error(`\nRun \`bun run bump:version ${canonical}\` to align.`);
      process.exit(1);
    }
    console.log(`All ${locations.length} version locations at ${canonical}.`);
    process.exit(0);
  }

  if (!arg) {
    console.log(readVersion(config.files[0]));
    process.exit(0);
  }

  if (!SEMVER.test(arg)) {
    console.error(`Not a valid semver: ${arg}`);
    process.exit(1);
  }

  for (const entry of config.files) writeVersion(entry, arg);
  console.log(`Bumped ${config.files.length} version locations to ${arg}.`);
}

if (import.meta.main) {
  main();
}
