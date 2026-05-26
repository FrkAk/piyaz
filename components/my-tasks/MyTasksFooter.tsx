"use client";

import { Kbd } from "@/components/shared/Kbd";
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
 * Bottom row of the list card. Left: `Showing N of M assigned · view view`
 * (suffix omitted when view === `all`). Right: keyboard navigation hints
 * (`↑↓ navigate · ↵ open`). Multi-select isn't shipping yet so the `X`
 * hint is intentionally absent per DESIGN.md § 10's "don't lie" guidance.
 *
 * @param props - Counts + view.
 * @returns Footer element.
 */
export function MyTasksFooter({ shown, total, view }: MyTasksFooterProps) {
  return (
    <footer className="mt-1 flex items-center gap-3 border-t border-border/50 pt-3.5 pb-1.5">
      <span className="text-[11.5px] text-text-muted">
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
      </span>
      <span className="flex-1" />
      <span className="hidden items-center gap-1.5 text-[11.5px] text-text-muted md:flex">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <span>navigate</span>
        <span aria-hidden="true" className="mx-1 inline-block h-3 w-px bg-border" />
        <Kbd>↵</Kbd>
        <span>open</span>
      </span>
    </footer>
  );
}
