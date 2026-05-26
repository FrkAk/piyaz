"use client";

import { SAVED_VIEW_LABEL, type SavedView } from "./predicates";

interface MyTasksFooterProps {
  /** Rows currently visible in the list. */
  shown: number;
  /** Total assigned rows (full payload). */
  total: number;
  /** Active saved view — drives the `· view view` suffix. */
  view: SavedView;
}

/**
 * Bottom row of the list card. Reads `Showing N of M assigned · view view`
 * (suffix omitted when `view === "all"`). No keyboard hints — rows are
 * native `<Link>` elements that respond to Tab + Enter without dedicated
 * shortcuts, so advertising `↑↓ navigate` would lie about behaviour the
 * page doesn't implement.
 *
 * @param props - Counts + view.
 * @returns Footer element.
 */
export function MyTasksFooter({ shown, total, view }: MyTasksFooterProps) {
  return (
    <footer className="mt-1 border-t border-border/50 pt-3.5 pb-1.5 text-[11.5px] text-text-muted">
      Showing{" "}
      <span className="font-mono font-semibold tabular-nums text-text-primary">
        {shown}
      </span>{" "}
      of{" "}
      <span className="font-mono font-semibold tabular-nums text-text-primary">
        {total}
      </span>{" "}
      assigned
      {view !== "all" && (
        <span> · {SAVED_VIEW_LABEL[view].toLowerCase()} view</span>
      )}
    </footer>
  );
}
