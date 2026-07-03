/**
 * Response-budget helpers for the MCP surface. Every list-shaped response
 * enforces a row cap with explicit truncation guidance so agents never pull
 * a whole project into context and always learn the narrowing call.
 */

/** Result of a {@link budgetLines} pass. */
export type BudgetedLines = {
  /** The lines that fit the budget. */
  lines: string[];
  /** True when lines were dropped. */
  truncated: boolean;
};

/**
 * Cap a line list at `limit`, appending one guidance line naming what was
 * dropped and how to fetch the rest.
 *
 * @param lines - Full line list.
 * @param limit - Maximum lines to keep.
 * @param guidance - How to fetch the remainder (e.g. a narrowing filter or
 *   cursor cue); rendered as `… +N more — <guidance>`.
 * @returns Budgeted lines plus the truncation flag.
 */
export function budgetLines(
  lines: string[],
  limit: number,
  guidance: string,
): BudgetedLines {
  if (lines.length <= limit) return { lines, truncated: false };
  const kept = lines.slice(0, limit);
  kept.push(`… +${lines.length - limit} more — ${guidance}`);
  return { lines: kept, truncated: true };
}

/**
 * Cap a text section at `maxChars`, appending guidance when cut. Cuts at the
 * last newline before the limit so no line is left half-rendered.
 *
 * @param text - Section text.
 * @param maxChars - Maximum characters to keep.
 * @param guidance - How to fetch the full content.
 * @returns The possibly-truncated text.
 */
export function truncateSection(
  text: string,
  maxChars: number,
  guidance: string,
): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastBreak = slice.lastIndexOf("\n");
  const kept = lastBreak > 0 ? slice.slice(0, lastBreak) : slice;
  return `${kept}\n… truncated — ${guidance}`;
}
