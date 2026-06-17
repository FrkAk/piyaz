import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEMVER,
  patternToRegExp,
  readVersion,
  writeVersion,
  readVersions,
  findDrift,
  type Entry,
} from "@/scripts/bump-version";

const root = process.cwd();
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

/**
 * Write content to a throwaway file in a fresh temp dir.
 * @param name - File name within the temp dir.
 * @param content - File body.
 * @returns Absolute path to the created file.
 */
function tempFile(name: string, content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "bumpver-")), name);
  writeFileSync(path, content);
  return path;
}

test("readVersion reads a JSON field", () => {
  const path = tempFile("plugin.json", `{"name":"x","version":"1.2.3"}`);
  expect(readVersion({ path, field: "version" })).toBe("1.2.3");
});

test("readVersion throws when the field is absent", () => {
  const path = tempFile("plugin.json", `{"name":"x"}`);
  expect(() => readVersion({ path, field: "version" })).toThrow();
});

test("writeVersion rewrites a JSON field and preserves formatting", () => {
  const path = tempFile(
    "plugin.json",
    `{\n  "name": "x",\n  "version": "1.0.0",\n  "keep": true\n}\n`,
  );
  writeVersion({ path, field: "version" }, "2.0.0");
  expect(readFileSync(path, "utf8")).toBe(
    `{\n  "name": "x",\n  "version": "2.0.0",\n  "keep": true\n}\n`,
  );
});

test("writeVersion throws when the field is absent", () => {
  const path = tempFile("plugin.json", `{"name":"x"}`);
  expect(() => writeVersion({ path, field: "version" }, "2.0.0")).toThrow();
});

test("writeVersion refuses a nested field that precedes the top-level one", () => {
  const original = `{\n  "engines": { "version": "9.9.9" },\n  "version": "1.0.0"\n}\n`;
  const path = tempFile("plugin.json", original);
  expect(() => writeVersion({ path, field: "version" }, "2.0.0")).toThrow(
    /nested/,
  );
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("pattern round-trips and leaves surrounding code untouched", () => {
  const path = tempFile(
    "create-server.ts",
    `const s = { name: "mymir", version: "1.0.0" };\n`,
  );
  const entry: Entry = { path, pattern: `name: "mymir", version: "{version}"` };
  expect(readVersion(entry)).toBe("1.0.0");
  writeVersion(entry, "2.0.0");
  expect(readFileSync(path, "utf8")).toBe(
    `const s = { name: "mymir", version: "2.0.0" };\n`,
  );
});

test("writeVersion does not interpret $ sequences in the pattern replacement", () => {
  // A literal `$1` in the pattern must survive verbatim; a naive string
  // replacement would expand it to the matched version group.
  const path = tempFile("v.txt", `tag$1 = "1.0.0"\n`);
  writeVersion({ path, pattern: `tag$1 = "{version}"` }, "2.0.0");
  expect(readFileSync(path, "utf8")).toBe(`tag$1 = "2.0.0"\n`);
});

test("patternToRegExp rejects zero or multiple {version} tokens", () => {
  expect(() => patternToRegExp("no token here")).toThrow();
  expect(() => patternToRegExp("{version} and {version}")).toThrow();
});

test("findDrift returns empty when every location matches the canonical", () => {
  const entries: Entry[] = [
    { path: tempFile("a.json", `{"version":"1.0.0"}`), field: "version" },
    { path: tempFile("b.json", `{"version":"1.0.0"}`), field: "version" },
  ];
  expect(findDrift(readVersions(entries))).toHaveLength(0);
});

test("findDrift flags the location that diverges from the canonical", () => {
  const drifted = tempFile("b.json", `{"version":"9.9.9"}`);
  const entries: Entry[] = [
    { path: tempFile("a.json", `{"version":"1.0.0"}`), field: "version" },
    { path: drifted, field: "version" },
  ];
  const drift = findDrift(readVersions(entries));
  expect(drift).toHaveLength(1);
  expect(drift[0].path).toBe(drifted);
});

test("SEMVER accepts releases and prereleases, rejects malformed input", () => {
  for (const ok of ["1.2.3", "0.0.1", "1.2.3-rc.1"]) {
    expect(SEMVER.test(ok)).toBe(true);
  }
  for (const bad of ["1.2", "v1.2.3", "1.2.3.4", "1.2.x"]) {
    expect(SEMVER.test(bad)).toBe(false);
  }
});

test(".version-bump.json entries all resolve against the live files", () => {
  const config = readJson(".version-bump.json") as { files: Entry[] };
  expect(config.files.length).toBeGreaterThan(0);
  for (const entry of config.files) {
    const hasField = "field" in entry;
    const hasPattern = "pattern" in entry;
    expect(hasField).not.toBe(hasPattern);
    if (hasPattern) {
      expect(() =>
        patternToRegExp((entry as { pattern: string }).pattern),
      ).not.toThrow();
    }
    expect(SEMVER.test(readVersion(entry))).toBe(true);
  }
});
