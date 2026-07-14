"use client";

import type { EdgeType } from "@/lib/types";

/** Active value for the edge filter pills. `all` shows every edge; the
 *  other values show ONLY their stratum (`notes` = every note edge). */
export type EdgeFilterValue = "all" | "depends_on" | "relates_to" | "notes";

interface EdgeFilterPillsProps {
  /** @param value - Currently active filter. */
  value: EdgeFilterValue;
  /** @param onChange - Called when a pill is clicked. */
  onChange: (next: EdgeFilterValue) => void;
  /** @param className - Additional CSS classes. */
  className?: string;
}

interface PillItem {
  id: EdgeFilterValue;
  label: string;
  /** Token color for the leading swatch. Omit for `all`. */
  tokenColor?: string;
}

const ITEMS: ReadonlyArray<PillItem> = [
  { id: "all", label: "All edges" },
  { id: "depends_on", label: "Depends on", tokenColor: "var(--color-depends)" },
  { id: "relates_to", label: "Relates to", tokenColor: "var(--color-relates)" },
  { id: "notes", label: "Note links", tokenColor: "var(--color-note-edge)" },
];

/**
 * Translate a pill value into the set of TASK edge types that should be
 * hidden. `all` hides nothing; the other values hide their complement
 * (`notes` hides both task strata). Note edge visibility is a separate
 * boolean — see {@link noteEdgesHiddenFor}.
 *
 * @param value - Active pill identifier.
 * @returns Task edge types to omit from the canvas.
 */
export function edgeFilterToHidden(value: EdgeFilterValue): Set<EdgeType> {
  if (value === "all") return new Set();
  if (value === "notes") return new Set<EdgeType>(["depends_on", "relates_to"]);
  if (value === "depends_on") return new Set<EdgeType>(["relates_to"]);
  return new Set<EdgeType>(["depends_on"]);
}

/**
 * Whether a pill value hides the note edge stratum. Only the task-stratum
 * pills do — `all` and `notes` both draw note edges.
 *
 * @param value - Active pill identifier.
 * @returns True when note edges should be omitted from the canvas.
 */
export function noteEdgesHiddenFor(value: EdgeFilterValue): boolean {
  return value === "depends_on" || value === "relates_to";
}

/**
 * Top-right segmented chip group used to filter visible edges in the graph
 * canvas. Active pill swaps to the raised surface with a small token swatch
 * up front so colour scanning still works.
 *
 * @param props - Active value + change callback.
 * @returns Inline pill row.
 */
export function EdgeFilterPills({
  value,
  onChange,
  className = "",
}: EdgeFilterPillsProps) {
  return (
    <div
      className={`flex flex-wrap items-center justify-end gap-1.5 ${className}`}
    >
      {ITEMS.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            aria-pressed={active}
            className={`inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors pointer-coarse:h-11 pointer-coarse:px-3.5 ${
              active
                ? "border-border-strong bg-surface-raised text-text-primary shadow-[var(--shadow-button)]"
                : "border-border-strong bg-surface text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            }`}
          >
            {item.tokenColor && (
              <span
                aria-hidden="true"
                className="block h-0.5 w-2 rounded-sm"
                style={{ background: item.tokenColor }}
              />
            )}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export default EdgeFilterPills;
