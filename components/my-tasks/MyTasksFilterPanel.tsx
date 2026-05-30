"use client";

import { AnimatePresence, motion } from "motion/react";
import { PriorityIcon } from "@/components/shared/PriorityIcon";
import type { Priority } from "@/lib/types";
import { PRIORITY_DISPLAY_ORDER, UNPRIORITIZED_KEY } from "@/lib/ui/priority";

interface MyTasksFilterPanelProps {
  open: boolean;
  activePriorities: ReadonlySet<string>;
  // Counts span the unfiltered view so a selected priority does not zero
  // out the others' counts.
  priorityCounts: Record<string, number>;
  onPriorityToggle: (value: string) => void;
  totalActive: number;
  onClearAll: () => void;
}

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
                  {totalActive} {totalActive === 1 ? "filter" : "filters"}{" "}
                  active
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
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] transition-colors ${
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
