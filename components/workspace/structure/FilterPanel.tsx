'use client';

import { motion, AnimatePresence } from 'motion/react';
import { PriorityIcon } from '@/components/shared/PriorityIcon';
import { STATUS_META } from '@/components/shared/StatusGlyph';
import type { Priority, TaskStatus } from '@/lib/types';

/** Status filter options exposed in the sheet — `ready` and `plannable` are derived. */
const STATUS_FILTERS: readonly { id: string; label: string }[] = [
  { id: 'in_progress', label: STATUS_META.in_progress.label },
  { id: 'ready',       label: 'Ready' },
  { id: 'planned',     label: STATUS_META.planned.label },
  { id: 'plannable',   label: 'Plannable' },
  { id: 'draft',       label: STATUS_META.draft.label },
  { id: 'done',        label: STATUS_META.done.label },
  { id: 'cancelled',   label: STATUS_META.cancelled.label },
];

interface FilterPanelProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** Active status filters (includes the derived `ready`). */
  activeStatuses: Set<string>;
  /** Toggle a status filter. */
  onStatusToggle: (id: string) => void;
  /** Available categories for the filter chips. */
  categories: string[];
  /** Active category filters. `Uncategorized` matches tasks without a category. */
  activeCategories: Set<string>;
  /** Toggle a category filter. */
  onCategoryToggle: (id: string) => void;
  /** Available tags with their per-tag counts. */
  tags: ReadonlyArray<readonly [string, number]>;
  /** Active tag filters. */
  activeTags: Set<string>;
  /** Toggle a tag filter. */
  onTagToggle: (id: string) => void;
  /** Priority filter options in display order. */
  priorities: readonly Priority[];
  /** Active priority filters. `Unprioritized` matches tasks without a priority. */
  activePriorities: Set<string>;
  /** Toggle a priority filter. */
  onPriorityToggle: (id: string) => void;
  /** Per-status counts for the chip badges. */
  statusCounts: Record<string, number>;
  /** Per-category counts. `__uncategorized__` keys the Uncategorized chip. */
  categoryCounts: Record<string, number>;
  /** Per-priority counts. The `Unprioritized` key counts tasks with `priority === null`. */
  priorityCounts: Record<string, number>;
  /** Total active filter count, drives the summary row. */
  totalActive: number;
  /** Clear every active filter at once. */
  onClearAll: () => void;
}

/**
 * Filter chip styling — accent-tinted when active, surface-raised when idle.
 * Counts use tabular numerals so columns stay aligned.
 *
 * @param active - Whether the chip is currently selected.
 * @returns Tailwind class string.
 */
function chipClass(active: boolean): string {
  return `cursor-pointer rounded-md border px-2 py-[3px] font-mono text-[10px] transition-colors ${
    active
      ? 'border-accent/30 bg-accent/10 text-accent-light font-semibold'
      : 'border-border bg-surface-raised/40 text-text-secondary hover:border-border-strong hover:bg-surface-hover hover:text-text-primary'
  }`;
}

/**
 * Slide-out filter sheet — three sections of chips (status, categories,
 * tags). Search is owned by the parent and rendered above the list so it
 * stays visible regardless of this sheet's open state.
 *
 * @param props - Filter sheet configuration.
 * @returns Animated panel below the search row.
 */
export function FilterPanel({
  open,
  activeStatuses,
  onStatusToggle,
  categories,
  activeCategories,
  onCategoryToggle,
  tags,
  activeTags,
  onTagToggle,
  priorities,
  activePriorities,
  onPriorityToggle,
  statusCounts,
  categoryCounts,
  priorityCounts,
  totalActive,
  onClearAll,
}: FilterPanelProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="overflow-hidden border-b border-border bg-surface"
        >
          <div className="space-y-3 px-4 py-3">
            {totalActive > 0 && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-accent-light">
                  {totalActive} {totalActive === 1 ? 'filter' : 'filters'} active
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

            <FilterSection title="Status">
              {STATUS_FILTERS.map((s) => {
                const count = statusCounts[s.id] ?? 0;
                if (count === 0 && !activeStatuses.has(s.id)) return null;
                const active = activeStatuses.has(s.id);
                return (
                  <button key={s.id} type="button" onClick={() => onStatusToggle(s.id)} className={chipClass(active)}>
                    {s.label}
                    <span className={`ml-1 tabular-nums ${active ? 'text-accent-light/70' : 'text-text-faint'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </FilterSection>

            {(categories.length > 0 || (categoryCounts.__uncategorized__ ?? 0) > 0) && (
              <FilterSection title="Categories">
                {categories.map((cat) => {
                  const count = categoryCounts[cat] ?? 0;
                  const active = activeCategories.has(cat);
                  return (
                    <button key={cat} type="button" onClick={() => onCategoryToggle(cat)} className={chipClass(active)}>
                      {cat}
                      <span className={`ml-1 tabular-nums ${active ? 'text-accent-light/70' : 'text-text-faint'}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
                {(categoryCounts.__uncategorized__ ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => onCategoryToggle('Uncategorized')}
                    className={chipClass(activeCategories.has('Uncategorized'))}
                  >
                    Uncategorized
                    <span className={`ml-1 tabular-nums ${activeCategories.has('Uncategorized') ? 'text-accent-light/70' : 'text-text-faint'}`}>
                      {categoryCounts.__uncategorized__}
                    </span>
                  </button>
                )}
              </FilterSection>
            )}

            <FilterSection title="Priority">
              {priorities.map((p) => {
                const count = priorityCounts[p] ?? 0;
                if (count === 0 && !activePriorities.has(p)) return null;
                const active = activePriorities.has(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onPriorityToggle(p)}
                    className={`${chipClass(active)} inline-flex items-center gap-1.5`}
                  >
                    <PriorityIcon priority={p} />
                    {p}
                    <span className={`tabular-nums ${active ? 'text-accent-light/70' : 'text-text-faint'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
              {(priorityCounts.Unprioritized ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => onPriorityToggle('Unprioritized')}
                  className={`${chipClass(activePriorities.has('Unprioritized'))} inline-flex items-center gap-1.5`}
                >
                  <PriorityIcon priority={null} />
                  Unprioritized
                  <span className={`tabular-nums ${activePriorities.has('Unprioritized') ? 'text-accent-light/70' : 'text-text-faint'}`}>
                    {priorityCounts.Unprioritized}
                  </span>
                </button>
              )}
            </FilterSection>

            {tags.length > 0 && (
              <FilterSection title="Tags">
                {tags.map(([tag, count]) => {
                  const active = activeTags.has(tag);
                  return (
                    <button key={tag} type="button" onClick={() => onTagToggle(tag)} className={chipClass(active)}>
                      {tag}
                      <span className={`ml-1 tabular-nums ${active ? 'text-accent-light/70' : 'text-text-faint'}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </FilterSection>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface FilterSectionProps {
  /** Section title rendered above the chip wrap. */
  title: string;
  /** Chip elements. */
  children: React.ReactNode;
}

/**
 * Mono uppercase label + chip wrap — keeps each filter group tidy.
 *
 * @param props - Section content.
 * @returns Sectioned chip container.
 */
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

/** Used by the consumer to suppress filter chips for statuses with zero hits unless already active. */
export type { TaskStatus };

export default FilterPanel;
