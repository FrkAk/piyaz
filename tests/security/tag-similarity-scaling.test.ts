import { test, expect } from "bun:test";
import { findVariant } from "@/lib/graph/tag-similarity";
import {
  MAX_HINTED_TAGS,
  resolveTagVariants,
  tagVariantHints,
} from "@/lib/graph/tools/shared";

/**
 * Attack-path coverage for tag variant detection.
 *
 * Both operands are caller-supplied: the proposed tags come off the request
 * and the existing vocabulary is whatever the same caller stored earlier. The
 * check is a cross product of the two, with an edit-distance matrix at each
 * pair, so an unbounded version turns one MCP call into minutes of CPU.
 */

const BUDGET_MS = 1_000;
const OVERSIZED_LENGTH = 200;
/** Just under the 64-character compare ceiling, so every admitted pair runs
 *  the full `levenshtein` matrix. */
const COMPARABLE_LENGTH = 60;
const VOCABULARY = 500;

/**
 * Build distinct tags of a given length that differ from each other only in
 * a short index prefix, so a pair can sit within variant distance.
 *
 * @param count - How many tags to build.
 * @param length - Character length of each tag.
 * @returns Distinct alphanumeric tags.
 */
function tags(count: number, length: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${String(i).padStart(6, "0")}${"a".repeat(length - 6)}`,
  );
}

/**
 * Build mutually dissimilar tags: each tag repeats its own index block, so
 * any two differ across every block and no pair is within variant distance.
 * No early exit fires, which is what makes a timing test discriminate.
 *
 * @param count - How many tags to build.
 * @param length - Character length of each tag.
 * @param offset - Index offset, for a pool disjoint from another call's.
 * @returns Distinct alphanumeric tags.
 */
function dissimilarTags(count: number, length: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, i) => {
    const block = String(i + offset).padStart(5, "0");
    return block.repeat(Math.ceil(length / block.length)).slice(0, length);
  });
}

test("attack: many long proposed tags against a large vocabulary stay bounded", () => {
  const existing = tags(VOCABULARY, OVERSIZED_LENGTH);
  const proposed = tags(VOCABULARY, OVERSIZED_LENGTH).map(
    (tag) => `z${tag.slice(1)}`,
  );

  const start = performance.now();
  tagVariantHints(proposed, existing);
  expect(performance.now() - start).toBeLessThan(BUDGET_MS);
});

test("attack: comparable-length tags reach the distance check and stay bounded", () => {
  // Nothing matches and nothing early-exits, so every comparison the
  // distinct-tag allowance admits runs a full 60x60 matrix against the whole
  // vocabulary. The allowance is the bound; without it this shape spends
  // seconds of CPU inside one MCP call.
  const existing = dissimilarTags(VOCABULARY, COMPARABLE_LENGTH);
  const proposed = dissimilarTags(VOCABULARY, COMPARABLE_LENGTH, VOCABULARY);

  const start = performance.now();
  tagVariantHints(proposed, existing);
  expect(performance.now() - start).toBeLessThan(BUDGET_MS);
});

test("an oversized tag still earns a hint when it duplicates an existing one", () => {
  // The length ceiling bounds the distance matrix only. Equality and prefix
  // are linear, and an exact duplicate is the clearest hint there is, so
  // skipping the whole comparison would drop the case worth reporting.
  const duplicate = "q".repeat(OVERSIZED_LENGTH);

  expect(findVariant(duplicate, [`${duplicate}!`])).toBe(`${duplicate}!`);
  expect(findVariant(duplicate, tags(VOCABULARY, OVERSIZED_LENGTH))).toBeNull();
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

test("the allowance counts distinct tags, so a batch does not starve its tail", () => {
  // A batch reusing one vocabulary across many items resolves every one of
  // them: the allowance is spent per distinct tag, not per occurrence.
  const proposed = Array.from({ length: 400 }, (_, i) => `backend${i % 3}`);
  const variants = resolveTagVariants(proposed, ["back-end"]);

  // All three resolve even though the last occurrence sits at index 399.
  expect(variants.size).toBe(3);
  expect(variants.get("backend2")).toBe("back-end");
  // One hint per distinct tag, not one per occurrence.
  expect(tagVariantHints(proposed, ["back-end"]).length).toBe(3);
});

test("attack: distinct proposed tags past the allowance are not compared", () => {
  const existing = tags(VOCABULARY, COMPARABLE_LENGTH);
  const proposed = tags(VOCABULARY, COMPARABLE_LENGTH).map(
    (tag) => `z${tag.slice(1)}`,
  );

  expect(resolveTagVariants(proposed, existing).size).toBeLessThanOrEqual(
    MAX_HINTED_TAGS,
  );
  expect(resolveTagVariants(proposed, existing, 0).size).toBe(0);
});
