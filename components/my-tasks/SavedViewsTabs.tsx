"use client";

import { SAVED_VIEWS, SAVED_VIEW_LABEL, type SavedView } from "./predicates";

interface SavedViewsTabsProps {
  /** Currently-active view. */
  value: SavedView;
  /** Counts per view, derived from the full payload. */
  counts: Record<SavedView, number>;
  /** Switch the active view. */
  onChange: (next: SavedView) => void;
}

/**
 * Segmented control with five fixed presets (open / today / stale / done /
 * all). Tabs render in fixed order; per-tab count chips swap to the accent
 * tone on the active tab. Keyboard `1`-`5` switching is wired by the
 * parent — this component only surfaces click handling.
 *
 * @param props - Active view + counts + onChange.
 * @returns Segmented control row.
 */
export function SavedViewsTabs({
  value,
  counts,
  onChange,
}: SavedViewsTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Saved views"
      className="inline-flex w-max gap-0.5 rounded-lg border border-border bg-surface-raised/60 p-1"
    >
      {SAVED_VIEWS.map((view) => {
        const active = view === value;
        return (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(view)}
            className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors duration-150 ${
              active
                ? "border-border bg-surface text-text-primary shadow-[var(--shadow-button)]"
                : "border-transparent bg-transparent text-text-muted hover:bg-surface-hover/70 hover:text-text-secondary"
            }`}
          >
            <span>{SAVED_VIEW_LABEL[view]}</span>
            <span
              className={`inline-flex items-center rounded px-1.5 py-px font-mono text-[10.5px] tabular-nums ${
                active
                  ? "bg-accent/12 text-accent-light"
                  : "bg-surface/70 text-text-faint"
              }`}
            >
              {counts[view]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
