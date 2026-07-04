/**
 * Response-budget helpers for the MCP surface. Every list-shaped response
 * enforces a row cap with explicit truncation guidance so agents never pull
 * a whole project into context and always learn the narrowing call.
 */

import { capLines } from "@/lib/context/format";

/** Result of a {@link budgetLines} pass. */
export type BudgetedLines = {
  /** The lines that fit the budget. */
  lines: string[];
  /** True when lines were dropped. */
  truncated: boolean;
};

/**
 * Cap a line list at `limit` via {@link capLines}, adding the truncation
 * flag callers log.
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
  return {
    lines: capLines(lines, guidance, limit),
    truncated: lines.length > limit,
  };
}
