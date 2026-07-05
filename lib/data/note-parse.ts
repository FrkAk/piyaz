/**
 * Pure markdown-body reference extractor for the Notes link-derivation
 * engine. Task refs (`<IDENTIFIER>-12`) and wiki links (`[[Title]]`)
 * never match inside fenced code blocks (CommonMark fence rules) or
 * inline code spans and bold runs (the prototype's inline semantics).
 * The Notes renderer must stay in lockstep with these semantics
 * (PYZ-258). No DB access — unit-testable in isolation;
 * `lib/data/note.ts` resolves the extracted refs in-tx.
 */

/**
 * Upper bound on distinct refs extracted per body, per kind. Bounds the
 * `IN (...)` list size of the in-transaction resolution queries.
 */
const MAX_REFS_PER_KIND = 200;

/** Distinct references extracted from one note body. */
export type ExtractedRefs = {
  /** Task sequence numbers referenced as `<IDENTIFIER>-<seq>`. */
  taskSeqs: number[];
  /** Wiki-link titles referenced as `[[Title]]`, trimmed, original case. */
  titles: string[];
};

/**
 * Escape RegExp metacharacters in a literal string.
 *
 * @param value - Literal string destined for a RegExp source.
 * @returns The escaped string.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Candidate fence line: up to 3 spaces of indent, then 3+ ` or ~. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Extract task and note references from a markdown body.
 *
 * Fenced code blocks follow CommonMark: an opening fence is a run of 3+
 * backticks or tildes after at most 3 spaces of indentation (a backtick
 * fence's info string may not contain a backtick), the closing fence is
 * a run of the same character at least as long as the opener with only
 * whitespace after it, and an unterminated fence swallows the rest of
 * the body. Fence-delimiter lines and fenced content are skipped
 * entirely. Inline code spans and bold runs are excluded by matching
 * them in the same alternation as the refs — leftmost-match-wins means a
 * span consumes its content before the ref patterns can see it,
 * mirroring the prototype's `INLINE_RE` split (which renders neither
 * chips nor doc links inside backticks or bold). Identifier matching is
 * case-insensitive.
 *
 * @param body - Markdown note body.
 * @param projectIdentifier - The owning project's identifier.
 * @returns Deduped task sequence numbers and wiki-link titles, capped at
 *   200 per kind.
 */
export function extractNoteRefs(
  body: string,
  projectIdentifier: string,
): ExtractedRefs {
  const taskSeqs = new Set<number>();
  const titles = new Set<string>();
  const seenTitleKeys = new Set<string>();
  const identifier = escapeRegExp(projectIdentifier);
  const inlineRe = new RegExp(
    String.raw`\b${identifier}-(\d+)\b|\[\[([^\]]+)\]\]|\*\*[^*]+\*\*|` +
      "`[^`]+`",
    "gi",
  );

  let fence: { char: string; length: number } | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = FENCE_LINE_RE.exec(line);
    if (fence !== null) {
      const [, marker = "", rest = ""] = fenceMatch ?? [];
      if (
        marker.charAt(0) === fence.char &&
        marker.length >= fence.length &&
        rest.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch !== null) {
      const [, marker = "", infoString = ""] = fenceMatch;
      if (marker.charAt(0) === "~" || !infoString.includes("`")) {
        fence = { char: marker.charAt(0), length: marker.length };
        continue;
      }
    }
    inlineRe.lastIndex = 0;
    for (
      let match = inlineRe.exec(line);
      match !== null;
      match = inlineRe.exec(line)
    ) {
      const [, seqGroup, titleGroup] = match;
      if (seqGroup !== undefined) {
        const seq = Number(seqGroup);
        if (Number.isSafeInteger(seq) && seq > 0) taskSeqs.add(seq);
        continue;
      }
      if (titleGroup !== undefined) {
        const title = titleGroup.trim();
        if (title === "") continue;
        const key = title.toLowerCase();
        if (seenTitleKeys.has(key)) continue;
        seenTitleKeys.add(key);
        titles.add(title);
      }
    }
  }

  return {
    taskSeqs: [...taskSeqs].slice(0, MAX_REFS_PER_KIND),
    titles: [...titles].slice(0, MAX_REFS_PER_KIND),
  };
}
