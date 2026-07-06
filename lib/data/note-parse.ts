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

/** Open fence state: the marker character and the opener's run length. */
export type FenceState = { char: string; length: number };

/**
 * Match a line as a CommonMark fence opener: a run of 3+ backticks or
 * tildes after at most 3 spaces of indentation, where a backtick fence's
 * info string may not contain a backtick.
 *
 * @param line - One body line.
 * @returns The fence state when the line opens a fence, else `null`.
 */
export function fenceOpen(line: string): FenceState | null {
  const match = FENCE_LINE_RE.exec(line);
  if (match === null) return null;
  const [, marker = "", infoString = ""] = match;
  if (marker.charAt(0) === "~" || !infoString.includes("`")) {
    return { char: marker.charAt(0), length: marker.length };
  }
  return null;
}

/**
 * Whether a line closes an open fence: a run of the same character at
 * least as long as the opener with only trailing whitespace.
 *
 * @param line - One body line.
 * @param fence - The open fence state.
 * @returns `true` when the line closes the fence.
 */
export function fenceCloses(line: string, fence: FenceState): boolean {
  const match = FENCE_LINE_RE.exec(line);
  if (match === null) return false;
  const [, marker = "", rest = ""] = match;
  return (
    marker.charAt(0) === fence.char &&
    marker.length >= fence.length &&
    rest.trim() === ""
  );
}

/**
 * Build the inline alternation used to match refs, wiki links, bold runs,
 * and inline code spans on a single source line, case-insensitively. Bold
 * and code are captured (groups 3 and 4) so the renderer can slice them;
 * the extractor reads only the ref (1) and title (2) groups. Leftmost-
 * match-wins lets a span consume refs inside it.
 *
 * @param projectIdentifier - The owning project's identifier.
 * @returns A fresh `gi` RegExp; reset `lastIndex` before reuse.
 */
export function buildInlineRe(projectIdentifier: string): RegExp {
  const identifier = escapeRegExp(projectIdentifier);
  return new RegExp(
    String.raw`\b${identifier}-(\d+)\b|\[\[([^\]]+)\]\]|(\*\*[^*]+\*\*)|` +
      "(`[^`]+`)",
    "gi",
  );
}

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
  const inlineRe = buildInlineRe(projectIdentifier);

  let fence: FenceState | null = null;
  for (const line of body.split("\n")) {
    if (fence !== null) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    fence = fenceOpen(line);
    if (fence !== null) continue;
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
