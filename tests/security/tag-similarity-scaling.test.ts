import { test, expect } from "bun:test";
import { findVariant } from "@/lib/graph/tag-similarity";
import { tagVariantHints } from "@/lib/graph/tools/shared";

/**
 * Attack-path coverage for tag variant detection.
 *
 * Both operands are caller-supplied: the proposed tags come off the request
 * and the existing vocabulary is whatever the same caller stored earlier. The
 * check is a cross product of the two, with an edit-distance matrix at each
 * pair, so an unbounded version turns one MCP call into minutes of CPU.
 */

const BUDGET_MS = 1_000;
const TAG_LENGTH = 200;
const VOCABULARY = 500;

/**
 * Build a vocabulary of long, mutually dissimilar tags.
 *
 * @param count - How many tags to build.
 * @returns Distinct tags of {@link TAG_LENGTH} characters.
 */
function longTags(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${String(i).padStart(6, "0")}${"a".repeat(TAG_LENGTH - 6)}`,
  );
}

test("attack: many long proposed tags against a large vocabulary stay bounded", () => {
  const existing = longTags(VOCABULARY);
  const proposed = longTags(VOCABULARY).map((tag) => `z${tag.slice(1)}`);

  const start = performance.now();
  tagVariantHints(proposed, existing);
  expect(performance.now() - start).toBeLessThan(BUDGET_MS);
});

test("attack: a single oversized tag skips the quadratic comparison", () => {
  const existing = longTags(VOCABULARY);

  const start = performance.now();
  expect(findVariant("q".repeat(TAG_LENGTH), existing)).toBeNull();
  expect(performance.now() - start).toBeLessThan(BUDGET_MS);
});

test("variant detection still fires for realistic tags", () => {
  expect(findVariant("backend", ["backend-api"])).toBe("backend-api");
  expect(findVariant("authentication", ["authentification"])).toBe(
    "authentification",
  );
  expect(findVariant("frontend", ["database"])).toBeNull();
});

test("hints are still produced for a normal batch", () => {
  const hints = tagVariantHints(["backend"], ["back-end"]);
  expect(hints.length).toBe(1);
  expect(hints[0]).toContain("back-end");
});
