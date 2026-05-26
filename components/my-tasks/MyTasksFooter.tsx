"use client";

interface MyTasksFooterProps {
  /** Rows currently visible in the list. */
  shown: number;
  /** Total assigned rows (full payload). */
  total: number;
}

/**
 * Bottom row of the list card. Reads `Showing N of M assigned`. The active
 * saved view is already visible in the tab row above, so repeating it here
 * would be redundant chrome. No keyboard hints — rows are native `<Link>`
 * elements that respond to Tab + Enter without dedicated shortcuts.
 *
 * @param props - Counts.
 * @returns Footer element.
 */
export function MyTasksFooter({ shown, total }: MyTasksFooterProps) {
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
    </footer>
  );
}
