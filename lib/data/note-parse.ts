/**
 * Pure markdown-body reference extractor for the Notes link-derivation
 * engine. Task refs (`[[<IDENTIFIER>-12]]`), note refs
 * (`[[<IDENTIFIER>-N12]]`), and note-title links (`[[Title]]`) share one
 * `[[…]]` construct: the inner value is a task ref when it matches
 * `<IDENTIFIER>-<seq>`, a note ref when it matches `<IDENTIFIER>-N<seq>`
 * (both case-insensitive), else a note title.
 * Refs never match inside fenced code blocks (CommonMark fence rules) or
 * inline code spans; refs inside bold runs are matched, so a reference
 * always reads and backlinks as one. The Notes renderer shares this
 * module's matcher and classifier to stay in lockstep (PYZ-258). No DB
 * access — unit-testable in isolation; `lib/data/note.ts` resolves the
 * extracted refs in-tx.
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
  /** Note sequence numbers referenced as `<IDENTIFIER>-N<seq>`. */
  noteSeqs: number[];
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

/** Core `[[…]]` ref pattern; group 1 is the inner text (no newline). */
const REF_PATTERN = String.raw`\[\[([^\]\n]+)\]\]`;

/**
 * Build the `[[…]]` ref matcher the renderer scans text nodes with.
 *
 * @returns A fresh `g` RegExp; group 1 is the inner text. Reset
 *   `lastIndex` before reuse.
 */
export function buildRefRe(): RegExp {
  return new RegExp(REF_PATTERN, "g");
}

/**
 * Build the extractor alternation: a `[[…]]` ref (group 1) or an inline
 * code span (group 2). Inline code is captured so leftmost-match-wins
 * lets it consume refs inside it; the extractor reads only group 1.
 *
 * @returns A fresh `g` RegExp; reset `lastIndex` before reuse.
 */
export function buildInlineRe(): RegExp {
  return new RegExp(REF_PATTERN + "|(`[^`]+`)", "g");
}

/**
 * Build the case-insensitive `<IDENTIFIER>-<seq>` task-ref classifier.
 *
 * @param projectIdentifier - The owning project's identifier.
 * @returns A RegExp anchored to a full inner value; group 1 is the seq.
 */
export function buildTaskRefRe(projectIdentifier: string): RegExp {
  return new RegExp(`^${escapeRegExp(projectIdentifier)}-(\\d+)$`, "i");
}

/**
 * Build the case-insensitive `<IDENTIFIER>-N<seq>` note-ref classifier.
 * The `N` segment keeps note refs disjoint from task refs, so one inner
 * value classifies as exactly one kind.
 *
 * @param projectIdentifier - The owning project's identifier.
 * @returns A RegExp anchored to a full inner value; group 1 is the seq.
 */
export function buildNoteRefRe(projectIdentifier: string): RegExp {
  return new RegExp(`^${escapeRegExp(projectIdentifier)}-N(\\d+)$`, "i");
}

/** A classified `[[…]]` reference. */
export type RefKind =
  | { kind: "task"; seq: number }
  | { kind: "note"; seq: number }
  | { kind: "wiki"; title: string };

/**
 * Classify a `[[…]]` inner value. A `<IDENTIFIER>-<seq>` inner with a
 * positive safe-integer seq is a task ref; a `<IDENTIFIER>-N<seq>` inner is
 * a note ref; any other non-empty inner is a note title; a blank inner is
 * not a reference.
 *
 * @param inner - The text between `[[` and `]]`.
 * @param taskRe - The classifier from {@link buildTaskRefRe}.
 * @param noteRe - The classifier from {@link buildNoteRefRe}.
 * @returns The classified ref, or `null` when it is not a reference.
 */
export function classifyRef(
  inner: string,
  taskRe: RegExp,
  noteRe: RegExp,
): RefKind | null {
  const trimmed = inner.trim();
  if (trimmed === "") return null;
  const taskMatch = taskRe.exec(trimmed);
  if (taskMatch !== null) {
    const seq = Number(taskMatch[1]);
    return Number.isSafeInteger(seq) && seq > 0 ? { kind: "task", seq } : null;
  }
  const noteMatch = noteRe.exec(trimmed);
  if (noteMatch !== null) {
    const seq = Number(noteMatch[1]);
    return Number.isSafeInteger(seq) && seq > 0 ? { kind: "note", seq } : null;
  }
  return { kind: "wiki", title: trimmed };
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
 * entirely. Inline code spans are excluded by matching them in the same
 * alternation as the refs — leftmost-match-wins means a span consumes its
 * content before the ref pattern can see it. Bold runs are not excluded,
 * so a ref inside `**bold**` is linked, in lockstep with the renderer.
 * Task-ref identifier matching is case-insensitive.
 *
 * @param body - Markdown note body.
 * @param projectIdentifier - The owning project's identifier.
 * @returns Deduped task sequence numbers, note sequence numbers, and note
 *   titles, capped at 200 per kind.
 */
export function extractNoteRefs(
  body: string,
  projectIdentifier: string,
): ExtractedRefs {
  const taskSeqs = new Set<number>();
  const noteSeqs = new Set<number>();
  const titles = new Set<string>();
  const seenTitleKeys = new Set<string>();
  const inlineRe = buildInlineRe();
  const taskRe = buildTaskRefRe(projectIdentifier);
  const noteRe = buildNoteRefRe(projectIdentifier);

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
      const inner = match[1];
      if (inner === undefined) continue;
      const ref = classifyRef(inner, taskRe, noteRe);
      if (ref === null) continue;
      if (ref.kind === "task") {
        taskSeqs.add(ref.seq);
        continue;
      }
      if (ref.kind === "note") {
        noteSeqs.add(ref.seq);
        continue;
      }
      const key = ref.title.toLowerCase();
      if (seenTitleKeys.has(key)) continue;
      seenTitleKeys.add(key);
      titles.add(ref.title);
    }
  }

  return {
    taskSeqs: [...taskSeqs].slice(0, MAX_REFS_PER_KIND),
    noteSeqs: [...noteSeqs].slice(0, MAX_REFS_PER_KIND),
    titles: [...titles].slice(0, MAX_REFS_PER_KIND),
  };
}

/** One ATX heading found outside fenced code. */
export type BodySection = {
  /** Heading level, 1-6. */
  level: number;
  /** Heading text, trimmed, without the `#` marker run. */
  text: string;
};

/** ATX heading shape: 1-6 `#`s after at most 3 spaces, then a space and text. */
const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * Match a line as an ATX heading, honoring the running fence state.
 *
 * @param line - One body line.
 * @returns The heading, or null when the line is not one.
 */
function matchHeading(line: string): BodySection | null {
  const match = line.match(ATX_HEADING_RE);
  if (!match || match[2] === "") return null;
  return { level: match[1].length, text: match[2] };
}

/**
 * List the ATX headings of a markdown body, fence-aware. Headings inside
 * fenced code blocks never match, in lockstep with {@link extractNoteRefs}.
 *
 * @param body - Markdown note body.
 * @returns Headings in document order.
 */
export function listSections(body: string): BodySection[] {
  const sections: BodySection[] = [];
  let fence: FenceState | null = null;
  for (const line of body.split("\n")) {
    if (fence !== null) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    fence = fenceOpen(line);
    if (fence !== null) continue;
    const heading = matchHeading(line);
    if (heading !== null) sections.push(heading);
  }
  return sections;
}

/**
 * Slice one heading's section out of a markdown body: from the matched
 * heading line to the line before the next heading of the same or a
 * shallower level, or to the end of the body. The heading text matches
 * case-insensitively after trimming; fenced code is ignored for both the
 * match and the terminator, in lockstep with {@link extractNoteRefs}.
 *
 * @param body - Markdown note body.
 * @param heading - Heading text to match (without `#` markers).
 * @returns The section text including its heading line, or null when no
 *   heading matches.
 */
export function extractSection(body: string, heading: string): string | null {
  const wanted = heading.trim().toLowerCase();
  if (wanted === "") return null;
  const lines = body.split("\n");
  let fence: FenceState | null = null;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence !== null) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    fence = fenceOpen(line);
    if (fence !== null) continue;
    const match = matchHeading(line);
    if (match === null) continue;
    if (start === -1) {
      if (match.text.toLowerCase() === wanted) {
        start = i;
        level = match.level;
      }
      continue;
    }
    if (match.level <= level) {
      return lines.slice(start, i).join("\n").trimEnd();
    }
  }
  if (start === -1) return null;
  return lines.slice(start).join("\n").trimEnd();
}
