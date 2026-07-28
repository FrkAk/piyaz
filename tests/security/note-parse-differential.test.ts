import { test, expect } from "bun:test";
import { matchHeading, scanLineRefs } from "@/lib/data/note-parse";

/**
 * Differential coverage: the forward scanners against the backtracking
 * patterns they replaced.
 *
 * `scanLineRefs` replaced the alternation ``\[\[([^\]\n]+)\]\]|(`[^`]+`)``
 * and `matchHeading` replaced `^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$`;
 * both rewrites must be match-equivalent, not merely faster. A seeded
 * generator keeps every run reproducible; the alphabet is weighted toward
 * the delimiter characters and includes CR, tab, astral and combining
 * characters so slicing is exercised across character boundaries.
 */

const OLD_REF = String.raw`\[\[([^\]\n]+)\]\]`;

/**
 * Extract ref inners with the replaced alternation pattern.
 *
 * @param line - Input line.
 * @returns Inner texts in document order.
 */
function oldScan(line: string): string[] {
  const re = new RegExp(`${OLD_REF}|(\`[^\`]+\`)`, "g");
  const out: string[] = [];
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

const OLD_ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * Match a heading with the replaced single-pattern form.
 *
 * @param line - Input line.
 * @returns The heading, or null when the line is not one.
 */
function oldHeading(line: string): { level: number; text: string } | null {
  const m = line.match(OLD_ATX);
  if (!m || m[2] === "") return null;
  return { level: (m[1] as string).length, text: m[2] as string };
}

/**
 * Deterministic 32-bit PRNG (mulberry32).
 *
 * @param seed - Initial state.
 * @returns A function yielding floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REF_ALPHA = [
  "[",
  "[",
  "]",
  "`",
  "`",
  "[",
  "]",
  "`",
  "a",
  " ",
  "\t",
  "P",
  "-",
  "1",
  "*",
  "\\",
  "\r",
  "é",
  "😀",
  "́",
];

const ATX_ALPHA = ["#", " ", "\t", "a", "1", "\r", "é", "😀"];

/**
 * Build a random line from an alphabet.
 *
 * @param rand - Seeded generator.
 * @param alpha - Weighted character alphabet.
 * @param maxLen - Maximum length in alphabet units.
 * @returns The generated line.
 */
function randLine(rand: () => number, alpha: string[], maxLen: number): string {
  const n = Math.floor(rand() * maxLen);
  let s = "";
  for (let k = 0; k < n; k++) {
    s += alpha[Math.floor(rand() * alpha.length)] as string;
  }
  return s;
}

test("scanLineRefs is match-equivalent to the replaced alternation", () => {
  const rand = mulberry32(0x5eed0001);
  let checked = 0;
  for (let t = 0; t < 20_000; t++) {
    const line = randLine(rand, REF_ALPHA, 120);
    const expected = oldScan(line);
    const actual = scanLineRefs(line);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      expect(actual, `line=${JSON.stringify(line)}`).toEqual(expected);
    }
    checked++;
  }
  expect(checked).toBe(20_000);
});

test("matchHeading is match-equivalent to the replaced single pattern", () => {
  const rand = mulberry32(0x5eed0002);
  let checked = 0;
  for (let t = 0; t < 20_000; t++) {
    const line = randLine(rand, ATX_ALPHA, 14);
    const expected = oldHeading(line);
    const actual = matchHeading(line);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      expect(actual, `line=${JSON.stringify(line)}`).toEqual(expected);
    }
    checked++;
  }
  expect(checked).toBe(20_000);
});

test("pinned interleaving case: a consumed backtick cannot open a span", () => {
  const line = "[[a`b]] [[X-2]] `x`";
  expect(scanLineRefs(line)).toEqual(["a`b", "X-2"]);
  expect(oldScan(line)).toEqual(["a`b", "X-2"]);
});
