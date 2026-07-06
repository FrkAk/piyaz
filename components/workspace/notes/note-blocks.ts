/**
 * Pure block/inline parsing for the Notes live editor. Chunk splitting,
 * block parsing, and inline tokenization share `lib/data/note-parse.ts`
 * semantics (CommonMark fences, per-source-line leftmost-match-wins
 * inline alternation) so the renderer never chips a ref the extractor
 * did not link. No React, no DB access; unit-testable in isolation.
 */

import {
  buildInlineRe,
  type FenceState,
  fenceCloses,
  fenceOpen,
} from "@/lib/data/note-parse";

/** One rendered markdown block inside a chunk. */
export type Block = {
  kind: "h2" | "p" | "ul" | "callout" | "code";
  text?: string;
  items?: string[];
  lang?: string;
};

/** One inline token produced by {@link tokenizeInline}. */
export type InlineToken =
  | { kind: "text" | "code" | "bold"; text: string }
  | { kind: "task"; text: string; seq: number }
  | { kind: "wiki"; text: string; title: string };

/**
 * Split a note body into editable chunks on blank-line runs, keeping
 * fenced code regions whole: blank lines inside a fence are content, not
 * chunk boundaries, and an unterminated fence swallows the rest of the
 * body into its chunk.
 *
 * @param body - Raw markdown body.
 * @returns Ordered non-empty chunks.
 */
export function splitChunks(body: string): string[] {
  const chunks: string[] = [];
  let buffer: string[] = [];
  let fence: FenceState | null = null;
  for (const line of body.split("\n")) {
    if (fence !== null) {
      buffer.push(line);
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    if (line === "") {
      if (buffer.length > 0) {
        chunks.push(buffer.join("\n"));
        buffer = [];
      }
      continue;
    }
    fence = fenceOpen(line);
    buffer.push(line);
  }
  if (buffer.length > 0) chunks.push(buffer.join("\n"));
  return chunks;
}

/**
 * Parse one chunk into ordered render blocks: `## ` headings, `> ` callout
 * runs, `- ` list runs, CommonMark fenced code, and paragraphs. Callout
 * and paragraph runs keep their source line boundaries (`\n`-joined) so
 * {@link tokenizeInline} can scan per line like the extractor. Fenced
 * code follows the extractor's rules: length-matched same-character
 * closer, backtick info strings may not contain a backtick, and an
 * unterminated fence swallows the rest of the chunk.
 *
 * @param chunk - One chunk from {@link splitChunks}.
 * @returns Ordered block list.
 */
export function parseBlocks(chunk: string): Block[] {
  const lines = chunk.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ kind: "h2", text: line.slice(3) });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: "callout", text: buf.join("\n") });
      continue;
    }
    const fence = fenceOpen(line);
    if (fence !== null) {
      const lang =
        line
          .replace(/^\s*(`{3,}|~{3,})/, "")
          .trim()
          .split(/\s+/)[0] || undefined;
      i++;
      const buf: string[] = [];
      while (i < lines.length && !fenceCloses(lines[i], fence)) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: "code", text: buf.join("\n"), lang });
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("## ") &&
      !lines[i].startsWith("- ") &&
      !lines[i].startsWith("> ") &&
      fenceOpen(lines[i]) === null
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", text: buf.join("\n") });
  }
  return blocks;
}

/**
 * Tokenize one block's text into inline tokens with the extractor's exact
 * alternation and flags: task refs, `[[Title]]` wiki links, bold runs, and
 * inline code spans, case-insensitive. Each source line is scanned
 * independently and the line streams join with a space text token, so a
 * code span or bold run never pairs across a line boundary, in lockstep
 * with the extractor's per-line scan. Leftmost-match-wins means a code
 * span or bold run consumes refs inside it, mirroring
 * `extractNoteRefs`. A ref whose sequence fails the extractor's guard or
 * a wiki link with a blank title degrades to a text token.
 *
 * @param text - A single block's text, possibly `\n`-joined source lines.
 * @param projectIdentifier - The owning project's identifier.
 * @returns Ordered inline tokens covering the whole input.
 */
export function tokenizeInline(
  text: string,
  projectIdentifier: string,
): InlineToken[] {
  const inlineRe = buildInlineRe(projectIdentifier);
  const tokens: InlineToken[] = [];
  const pushText = (value: string) => {
    if (value === "") return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === "text") last.text += value;
    else tokens.push({ kind: "text", text: value });
  };
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (lineIndex > 0) pushText(" ");
    inlineRe.lastIndex = 0;
    let cursor = 0;
    for (
      let match = inlineRe.exec(line);
      match !== null;
      match = inlineRe.exec(line)
    ) {
      pushText(line.slice(cursor, match.index));
      cursor = match.index + match[0].length;
      const [raw, seqGroup, titleGroup, boldGroup, codeGroup] = match;
      if (seqGroup !== undefined) {
        const seq = Number(seqGroup);
        if (Number.isSafeInteger(seq) && seq > 0) {
          tokens.push({ kind: "task", text: raw, seq });
        } else {
          pushText(raw);
        }
        continue;
      }
      if (titleGroup !== undefined) {
        const title = titleGroup.trim();
        if (title === "") pushText(raw);
        else tokens.push({ kind: "wiki", text: raw, title });
        continue;
      }
      if (boldGroup !== undefined) {
        tokens.push({ kind: "bold", text: raw.slice(2, -2) });
        continue;
      }
      if (codeGroup !== undefined) {
        tokens.push({ kind: "code", text: raw.slice(1, -1) });
      }
    }
    pushText(line.slice(cursor));
  }
  return tokens;
}
