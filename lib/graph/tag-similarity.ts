/**
 * Pure helpers for detecting tag variants across case, punctuation,
 * plural form, and small edit distance. No DB access.
 */

/**
 * Closed-vocabulary work-type tags (one per task) per `artifacts.md` §2.
 */
export const WORK_TYPE_TAGS: ReadonlySet<string> = new Set([
  "bug",
  "feature",
  "refactor",
  "docs",
  "test",
  "chore",
  "perf",
]);

/**
 * Identify the closed-vocabulary dimension a tag belongs to, if any.
 * Returns null for open-vocabulary dimensions (cross-cutting concern, tech).
 *
 * @param tag - Lowercased tag to classify.
 * @returns "work-type" or null.
 */
function closedDimension(tag: string): "work-type" | null {
  const lower = tag.toLowerCase();
  if (WORK_TYPE_TAGS.has(lower)) return "work-type";
  return null;
}

/**
 * Trim each tag and drop empty entries.
 * @param tags - Raw tag strings (may be undefined).
 * @returns Trimmed, non-empty tag list.
 */
export function normalizeTags(tags?: string[]): string[] {
  return tags?.map((t) => t.trim()).filter((t) => t.length > 0) ?? [];
}

/**
 * Normalize a tag for comparison: lowercase, strip non-alphanumeric,
 * trim trailing 's' on words longer than 3 chars.
 * @param tag - Raw tag string.
 * @returns Normalized form used for variant matching.
 */
export function normalizeTag(tag: string): string {
  const lower = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
  return lower.endsWith("s") && lower.length > 3 ? lower.slice(0, -1) : lower;
}

/**
 * Levenshtein edit distance between two strings.
 * @param a - First string.
 * @param b - Second string.
 * @returns Minimum number of insert/delete/replace operations.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find an existing tag that `proposed` looks like a variant of.
 * Matches on normalized equality, prefix containment (4+ chars), or
 * Levenshtein distance ≤ 2 (4+ chars). Returns null on exact raw
 * match or no variant found.
 * @param proposed - Proposed tag to check.
 * @param existing - Current project tag list.
 * @returns The first matching existing tag, or null.
 */
export function findVariant(proposed: string, existing: string[]): string | null {
  const nProposed = normalizeTag(proposed);
  if (nProposed.length === 0) return null;
  const proposedDim = closedDimension(proposed);
  for (const e of existing) {
    if (e === proposed) return null;
    const existingDim = closedDimension(e);
    if (
      proposedDim !== null &&
      existingDim !== null &&
      proposedDim !== existingDim
    ) {
      continue;
    }
    const nE = normalizeTag(e);
    if (nE === nProposed) return e;
    if (
      nE.length >= 4 &&
      nProposed.length >= 4 &&
      (nE.startsWith(nProposed) || nProposed.startsWith(nE))
    )
      return e;
    if (nProposed.length >= 4 && levenshtein(nProposed, nE) <= 2) return e;
  }
  return null;
}
