import { test, expect } from "bun:test";
import { extractNoteRefs, listSections } from "@/lib/data/note-parse";

/**
 * Attack-path coverage for note parsing cost.
 *
 * `extractNoteRefs` runs inside the note write transaction and `listSections`
 * runs on every read, both over a body the caller authored. A parse whose cost
 * grows with the square of the body length turns one stored note into a stall
 * that is paid on every later request, so these pin that an adversarial body
 * stays cheap at a size where a quadratic parse would not.
 *
 * The bound is deliberately loose: it is checking a complexity class, not a
 * throughput target, and a quadratic parse misses it by orders of magnitude.
 */

const BODY_SIZE = 200_000;
const BUDGET_MS = 1_000;

/**
 * Measure how long a parse takes.
 *
 * @param run - The parse to time.
 * @returns Elapsed milliseconds.
 */
function elapsed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

test("attack: a body of unclosed wiki links does not stall the write path", () => {
  const body = "[".repeat(BODY_SIZE);
  expect(elapsed(() => extractNoteRefs(body, "PYZ"))).toBeLessThan(BUDGET_MS);
});

test("attack: wiki links closed only at the very end do not stall the write path", () => {
  const body = `${"[".repeat(BODY_SIZE)}]x]`;
  expect(elapsed(() => extractNoteRefs(body, "PYZ"))).toBeLessThan(BUDGET_MS);
});

test("attack: a heading with a long whitespace run does not stall the read path", () => {
  const body = `# a${" ".repeat(BODY_SIZE)}x`;
  expect(elapsed(() => listSections(body))).toBeLessThan(BUDGET_MS);
});

test("a backtick consumed inside a ref does not swallow later refs", () => {
  // The alternation this replaced matched leftmost-first, so a backtick taken
  // as ref content could never open an inline code span. Locating spans
  // independently invents one here and drops every later ref on the line.
  const refs = extractNoteRefs("[[a`b]] [[PYZ-2]] `x`", "PYZ");
  expect(refs.taskSeqs).toEqual([2]);
  expect(refs.titles).toEqual(["a`b"]);
});

test("an unclosed backtick does not end the scan", () => {
  const refs = extractNoteRefs("[[PYZ-1]] ` [[PYZ-2]]", "PYZ");
  expect(refs.taskSeqs).toEqual([1, 2]);
});

test("a code span still hides the refs inside it", () => {
  expect(extractNoteRefs("`[[PYZ-1]]` [[PYZ-2]]", "PYZ").taskSeqs).toEqual([2]);
  expect(extractNoteRefs("a `b [[PYZ-1]] c` d", "PYZ").taskSeqs).toEqual([]);
});

test("refs and headings still parse correctly after the rewrite", () => {
  const refs = extractNoteRefs(
    "see [[PYZ-12]] and [[PYZ-N3]] and [[Some Title]], not `[[PYZ-99]]`",
    "PYZ",
  );
  expect(refs.taskSeqs).toEqual([12]);
  expect(refs.noteSeqs).toEqual([3]);
  expect(refs.titles).toEqual(["Some Title"]);

  expect(listSections("## Heading ##")).toEqual([
    { level: 2, text: "Heading" },
  ]);
  expect(listSections("# Kept # Inner")).toEqual([
    { level: 1, text: "Kept # Inner" },
  ]);
});
