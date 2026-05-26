"use client";

import { AnimatePresence, motion } from "motion/react";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import type { Priority } from "@/lib/types";
import { PRIORITY_DISPLAY_ORDER, UNPRIORITIZED_KEY } from "@/lib/ui/priority";

interface MyTasksFilterPanelProps {
  /** Whether the panel is open — drives the height/opacity transition. */
  open: boolean;
  /** Active priority filter set, including `Unprioritized` when active. */
  activePriorities: ReadonlySet<string>;
  /**
   * Per-priority counts derived from the *unfiltered* active view (status
   * filter does not narrow these — the operator should still see how many
   * urgent rows exist even while another priority is selected).
   */
  priorityCounts: Record<string, number>;
  /** Toggle a single priority value in the active set. */
  onPriorityToggle: (value: string) => void;
  /** Total active filter count across every dimension (status + priority + search). */
  totalActive: number;
  /** Clear every active filter at once. */
  onClearAll: () => void;
}

/**
 * Animated slide-out chip sheet, mirroring `components/workspace/structure/
 * FilterPanel.tsx`. The `/my-tasks` variant ships Priority only — Status
 * lives in the header pill row and Category vocabularies vary per project
 * so a unified chip list would balloon. Add Category / Tags as a follow-up
 * if the team needs them.
 *
 * @param props - Panel state + handlers.
 * @returns Animated panel container.
 */
export function MyTasksFilterPanel({
  open,
  activePriorities,
  priorityCounts,
  onPriorityToggle,
  totalActive,
  onClearAll,
}: MyTasksFilterPanelProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="overflow-hidden border-t border-border bg-surface"
        >
          <div className="space-y-3 px-4 py-3">
            {totalActive > 0 && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-accent-light">
                  {totalActive} {totalActive === 1 ? "filter" : "filters"} active
                </span>
                <button
                  type="button"
                  onClick={onClearAll}
                  className="cursor-pointer font-mono text-[10px] text-text-muted transition-colors hover:text-accent-light"
                >
                  Clear all
                </button>
              </div>
            )}

            <FilterSection title="Priority">
              {PRIORITY_DISPLAY_ORDER.map((p) => {
                const count = priorityCounts[p] ?? 0;
                if (count === 0 && !activePriorities.has(p)) return null;
                return (
                  <PriorityChipButton
                    key={p}
                    priority={p}
                    label={p}
                    active={activePriorities.has(p)}
                    count={count}
                    onToggle={() => onPriorityToggle(p)}
                  />
                );
              })}
              {((priorityCounts[UNPRIORITIZED_KEY] ?? 0) > 0 ||
                activePriorities.has(UNPRIORITIZED_KEY)) && (
                <PriorityChipButton
                  priority={null}
                  label="Unprioritized"
                  active={activePriorities.has(UNPRIORITIZED_KEY)}
                  count={priorityCounts[UNPRIORITIZED_KEY] ?? 0}
                  onToggle={() => onPriorityToggle(UNPRIORITIZED_KEY)}
                />
              )}
            </FilterSection>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface FilterSectionProps {
  title: string;
  children: React.ReactNode;
}

function FilterSection({ title, children }: FilterSectionProps) {
  return (
    <div>
      <span className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-text-muted">
        {title}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

interface PriorityChipButtonProps {
  priority: Priority | null;
  label: string;
  active: boolean;
  count: number;
  onToggle: () => void;
}

function PriorityChipButton({
  priority,
  label,
  active,
  count,
  onToggle,
}: PriorityChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-[3px] font-mono text-[10px] transition-colors ${
        active
          ? "border-accent/30 bg-accent/10 font-semibold text-accent-light"
          : "border-border bg-surface-raised/40 text-text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-text-primary"
      }`}
    >
      <PriorityIcon priority={priority} />
      <span className="capitalize">{label}</span>
      <span
        className={`tabular-nums ${active ? "text-accent-light/70" : "text-text-faint"}`}
      >
        {count}
      </span>
    </button>
  );
}
