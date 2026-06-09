import { readFileSync, writeFileSync } from "node:fs";

const CONFIG_PATH = ".version-bump.json";
const SEMVER = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const VERSION_CAPTURE = "(\\d+\\.\\d+\\.\\d+(?:-[A-Za-z0-9.]+)?)";

interface FieldEntry {
  path: string;
  field: string;
}

interface PatternEntry {
  path: string;
  pattern: string;
}

type Entry = FieldEntry | PatternEntry;

interface Config {
  files: Entry[];
}

/**
 * Type guard for JSON-field version entries.
 * @param entry - Entry to test.
 * @returns True when the entry targets a JSON field.
 */
function isFieldEntry(entry: Entry): entry is FieldEntry {
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
 * @throws Error when the pattern lacks a `{version}` token.
 */
function patternToRegExp(pattern: string): RegExp {
  if (!pattern.includes("{version}")) {
    throw new Error(`pattern is missing a {version} token: ${pattern}`);
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
function readVersion(entry: Entry): string {
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
 */
function writeVersion(entry: Entry, version: string): void {
  const content = readFileSync(entry.path, "utf8");
  if (isFieldEntry(entry)) {
    const re = new RegExp(`("${entry.field}"\\s*:\\s*")[^"]*(")`);
    if (!re.test(content)) {
      throw new Error(`${entry.path} has no ${entry.field} field to bump`);
    }
    writeFileSync(entry.path, content.replace(re, `$1${version}$2`));
    return;
  }
  const next = content.replace(
    patternToRegExp(entry.pattern),
    entry.pattern.replace("{version}", version),
  );
  writeFileSync(entry.path, next);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
const arg = process.argv[2];

if (arg === "--check") {
  const versions = config.files.map((entry) => ({
    path: entry.path,
    version: readVersion(entry),
  }));
  const canonical = versions[0].version;
  const drift = versions.filter((v) => v.version !== canonical);
  if (drift.length > 0) {
    console.error(`Version drift (canonical ${canonical}):`);
    for (const v of drift) console.error(`  ${v.version}  ${v.path}`);
    console.error(`\nRun \`bun run bump:version ${canonical}\` to align.`);
    process.exit(1);
  }
  console.log(`All ${versions.length} version locations at ${canonical}.`);
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
